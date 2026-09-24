#!/bin/sh
set -eu
# Operator-run upgrade for a database initialized before separate migration and runtime
# roles existed (POSTGRES_USER=signhere). Never runs automatically; see docs/deployment.md.
#   docker compose stop signhere
#   docker compose exec -T postgres sh /usr/local/share/signhere/upgrade-legacy-roles.sh --confirm
# One transaction renames the legacy bootstrap superuser to postgres (PostgreSQL 16+ cannot
# demote it), creates signhere_migrator and a restricted signhere role, moves ownership and
# verifies the result. Rerunning after success is a no-op. Passwords come from the
# environment, as in 10-signhere-roles.sh; neither arguments nor output contain them.

if [ "${1:-}" != --confirm ]; then
  echo 'Take a tested backup and stop the signhere service, then rerun with --confirm.' >&2
  exit 2
fi
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}"
database="${POSTGRES_DB:-signhere}"
run() { user=$1; shift; psql -X -q -v ON_ERROR_STOP=1 --username "$user" --dbname "$database" "$@"; }
# A temporary superuser performs the rename, because a session cannot rename its own role.
cleanup() {
  for user in postgres signhere; do
    run "$user" -c 'DROP ROLE IF EXISTS signhere_upgrade' >/dev/null 2>&1 && return 0
  done
  echo 'Warning: could not drop the temporary signhere_upgrade role; drop it manually.' >&2
}

# The image trusts local socket connections; use whichever administrator role exists.
admin=
for candidate in postgres signhere; do
  if run "$candidate" -Atc 'SELECT 1' >/dev/null 2>&1; then admin=$candidate; break; fi
done
if [ -z "$admin" ]; then
  echo "Cannot connect to database $database over the local socket as postgres or signhere." >&2
  exit 1
fi
IFS='|' read -r bootstrap superuser migrator <<EOF
$(run "$admin" -Atc "SELECT (SELECT rolname FROM pg_roles WHERE oid = 10), rolsuper, EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'signhere_migrator') FROM pg_roles WHERE rolname = current_user")
EOF
if [ "$bootstrap" = postgres ] && [ "$migrator" = t ]; then
  cleanup
  echo 'Database roles already use the separated layout; nothing to upgrade.'
  exit 0
fi
if [ "$bootstrap" != signhere ] || [ "$superuser" != t ]; then
  echo "Unrecognized role layout (bootstrap superuser: $bootstrap). This script only upgrades the legacy signhere layout." >&2
  exit 1
fi
others=$(run signhere -Atc "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()")
if [ "$others" != 0 ]; then
  echo "Stop the signhere service first: $others other database session(s) are open." >&2
  exit 1
fi

trap cleanup EXIT
run signhere -c 'SET client_min_messages = warning' -c 'DROP ROLE IF EXISTS signhere_upgrade' -c 'CREATE ROLE signhere_upgrade SUPERUSER LOGIN'
run signhere_upgrade <<'SQL'
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
-- The bootstrap superuser is available only through local container administration.
ALTER ROLE postgres PASSWORD NULL;
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
run postgres -c 'DROP ROLE signhere_upgrade'
trap - EXIT
echo 'Upgraded: postgres is the local-only superuser, signhere_migrator owns the schema, and signhere is the restricted runtime role.'
