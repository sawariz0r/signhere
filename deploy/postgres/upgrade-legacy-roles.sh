#!/bin/sh
set -eu
# Upgrades a database initialized before separate migration and runtime roles existed
# (POSTGRES_USER=signhere). The postgres-upgrade Compose service runs it before every
# application start and it is a no-op on current installations; see docs/deployment.md.
# It works over the network with passwords (PGHOST=postgres) or over the postgres
# container's trusted local socket.
# The legacy path optionally dumps the database to $SIGNHERE_UPGRADE_BACKUP_DIR, then one
# transaction renames the legacy bootstrap superuser to postgres (PostgreSQL 16+ cannot
# demote it), creates signhere_migrator and a restricted signhere role, moves ownership and
# verifies the result. Passwords come from the environment, as in 10-signhere-roles.sh;
# neither arguments nor output contain them.

if [ "${1:-}" != --confirm ]; then
  echo 'Take a tested backup and stop the signhere service, then rerun with --confirm.' >&2
  exit 2
fi
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}"
if [ "$POSTGRES_PASSWORD" = "$APP_DATABASE_PASSWORD" ]; then
  echo 'POSTGRES_PASSWORD and APP_DATABASE_PASSWORD must be different.' >&2
  exit 1
fi
database="${POSTGRES_DB:-signhere}"
run() { user=$1; password=$2; shift 2; PGPASSWORD=$password psql -X -q -v ON_ERROR_STOP=1 --username "$user" --dbname "$database" "$@"; }
can_login() { run "$1" "$2" -Atc 'SELECT 1' >/dev/null 2>&1; }
# The renamed bootstrap superuser keeps POSTGRES_PASSWORD only until the temporary role is gone.
finish() { run postgres "$POSTGRES_PASSWORD" -c 'SET client_min_messages = warning' -c 'DROP ROLE IF EXISTS signhere_upgrade' -c 'ALTER ROLE postgres PASSWORD NULL'; }
cleanup() {
  finish >/dev/null 2>&1 ||
    run signhere "$POSTGRES_PASSWORD" -c 'SET client_min_messages = warning' -c 'DROP ROLE IF EXISTS signhere_upgrade' >/dev/null 2>&1 ||
    echo 'Warning: could not drop the temporary signhere_upgrade role; drop it manually.' >&2
}

attempt=0
until pg_isready -q --dbname "$database"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo 'PostgreSQL is not accepting connections.' >&2; exit 1; fi
  sleep 2
done
if can_login signhere_migrator "$POSTGRES_PASSWORD"; then
  # Completes an upgrade interrupted after its transaction committed.
  if can_login postgres "$POSTGRES_PASSWORD"; then finish >/dev/null; fi
  echo 'Database roles already use the separated layout; nothing to upgrade.'
  exit 0
fi
if ! can_login signhere "$POSTGRES_PASSWORD"; then
  echo 'Cannot log in as signhere_migrator, or as the legacy signhere superuser, with POSTGRES_PASSWORD.' >&2
  echo 'If the legacy superuser password differs, run this script inside the postgres container instead.' >&2
  exit 1
fi
if [ "$(run signhere "$POSTGRES_PASSWORD" -Atc 'SELECT oid = 10 AND rolsuper FROM pg_roles WHERE rolname = current_user')" != t ]; then
  echo 'signhere is not the legacy bootstrap superuser; this script only upgrades the legacy layout.' >&2
  exit 1
fi
echo 'Legacy database roles found; upgrading.'
attempt=0
while [ "$(run signhere "$POSTGRES_PASSWORD" -Atc "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND usename IS NOT NULL AND pid <> pg_backend_pid()")" != 0 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 12 ]; then echo 'Stop the signhere service first: other database sessions are still open.' >&2; exit 1; fi
  sleep 5
done
if [ -n "${SIGNHERE_UPGRADE_BACKUP_DIR:-}" ]; then
  backup="$SIGNHERE_UPGRADE_BACKUP_DIR/pre-role-upgrade-$(date -u +%Y%m%dT%H%M%SZ).dump"
  (umask 077 && PGPASSWORD=$POSTGRES_PASSWORD pg_dump --username signhere --dbname "$database" -Fc -f "$backup")
  echo "Backed up the legacy database to $backup."
fi

# A temporary superuser performs the rename, because a session cannot rename its own role.
UPGRADE_PASSWORD=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
export UPGRADE_PASSWORD
trap cleanup EXIT
run signhere "$POSTGRES_PASSWORD" <<'SQL'
SET client_min_messages = warning;
DROP ROLE IF EXISTS signhere_upgrade;
\getenv upgrade_password UPGRADE_PASSWORD
SELECT format('CREATE ROLE signhere_upgrade SUPERUSER LOGIN PASSWORD %L', :'upgrade_password') \gexec
SQL
run signhere_upgrade "$UPGRADE_PASSWORD" <<'SQL'
\getenv migration_password POSTGRES_PASSWORD
\getenv runtime_password APP_DATABASE_PASSWORD
SELECT :'migration_password' = :'runtime_password' AS passwords_match \gset
\if :passwords_match
\echo 'POSTGRES_PASSWORD and APP_DATABASE_PASSWORD must be different.'
SELECT 1 / 0;
\endif
SELECT current_database() AS database \gset
BEGIN;
SET LOCAL lock_timeout = '10s';
-- The bootstrap role keeps OID 10 and everything it owns; only its name changes.
ALTER ROLE signhere RENAME TO postgres;
-- Temporary: finish() logs in with it to drop signhere_upgrade, then removes it.
SELECT format('ALTER ROLE postgres PASSWORD %L', :'migration_password') \gexec
CREATE ROLE signhere_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE signhere LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
SELECT format('ALTER ROLE signhere_migrator PASSWORD %L', :'migration_password') \gexec
SELECT format('ALTER ROLE signhere PASSWORD %L', :'runtime_password') \gexec
-- REASSIGN OWNED refuses the bootstrap superuser, so move each application object explicitly.
DO $$
DECLARE item record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') THEN
    RAISE EXCEPTION 'Database extensions are installed; upgrade this database manually.';
  END IF;
  FOR item IN SELECT nspname FROM pg_namespace
      WHERE (nspowner = 10 OR nspname = 'public') AND nspname !~ '^pg_' AND nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO signhere_migrator', item.nspname);
  END LOOP;
  -- Indexes and linked (serial/identity) sequences follow their table.
  FOR item IN SELECT c.oid::regclass AS name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S')
        AND NOT (c.relkind = 'S' AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i'))) LOOP
    EXECUTE format('ALTER %s %s OWNER TO signhere_migrator', CASE item.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, item.name);
  END LOOP;
  FOR item IN SELECT p.oid::regprocedure AS name, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER %s %s OWNER TO signhere_migrator', CASE item.prokind WHEN 'a' THEN 'AGGREGATE' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, item.name);
  END LOOP;
  -- Array, multirange and table row types follow their parent object.
  FOR item IN SELECT t.oid::regtype AS name, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_class c ON c.oid = t.typrelid
      WHERE t.typowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND (t.typtype IN ('d','e','r') OR (t.typtype = 'c' AND c.relkind = 'c')) LOOP
    EXECUTE format('ALTER %s %s OWNER TO signhere_migrator', CASE item.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, item.name);
  END LOOP;
  FOR item IN SELECT oid FROM pg_largeobject_metadata WHERE lomowner = 10 LOOP
    EXECUTE format('ALTER LARGE OBJECT %s OWNER TO signhere_migrator', item.oid);
  END LOOP;
  -- Fail closed on any object kind this script does not move.
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner = 10 AND nspname !~ '^pg_' AND nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_collation x JOIN pg_namespace n ON n.oid = x.collnamespace WHERE x.collowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_operator x JOIN pg_namespace n ON n.oid = x.oprnamespace WHERE x.oprowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_conversion x JOIN pg_namespace n ON n.oid = x.connamespace WHERE x.conowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_ts_config x JOIN pg_namespace n ON n.oid = x.cfgnamespace WHERE x.cfgowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_ts_dict x JOIN pg_namespace n ON n.oid = x.dictnamespace WHERE x.dictowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_statistic_ext x JOIN pg_namespace n ON n.oid = x.stxnamespace WHERE x.stxowner = 10 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS(SELECT 1 FROM pg_largeobject_metadata WHERE lomowner = 10) THEN
    RAISE EXCEPTION 'Some application objects are still owned by the legacy superuser; upgrade this database manually.';
  END IF;
END $$;
-- Same privileges as 10-signhere-roles.sh, plus grants on the tables that already exist.
ALTER DATABASE :"database" OWNER TO signhere_migrator;
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO signhere;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO signhere;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO signhere;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO signhere;
ALTER DEFAULT PRIVILEGES FOR ROLE signhere_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO signhere;
ALTER DEFAULT PRIVILEGES FOR ROLE signhere_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO signhere;
-- Verify before commit; any failure rolls the whole upgrade back.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('signhere', 'signhere_migrator') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Upgraded application roles are privileged.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S','i','I') AND pg_has_role('signhere', c.relowner, 'USAGE')) THEN
    RAISE EXCEPTION 'The runtime role owns database objects.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND NOT (has_table_privilege('signhere', c.oid, 'SELECT') AND has_table_privilege('signhere', c.oid, 'INSERT')
        AND has_table_privilege('signhere', c.oid, 'UPDATE') AND has_table_privilege('signhere', c.oid, 'DELETE'))) THEN
    RAISE EXCEPTION 'The runtime role lacks table access.';
  END IF;
  IF has_schema_privilege('signhere', 'public', 'CREATE') OR has_database_privilege('signhere', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'The runtime role can create schema objects.';
  END IF;
END $$;
SET LOCAL ROLE signhere;
DO $$
BEGIN
  BEGIN
    CREATE TABLE public.signhere_upgrade_probe(id integer);
    RAISE EXCEPTION 'The runtime role can create tables.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
COMMIT;
SQL
finish
trap - EXIT
echo 'Upgraded: postgres is the local-only superuser, signhere_migrator owns the schema, and signhere is the restricted runtime role.'
