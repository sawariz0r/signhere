#!/bin/sh
set -eu
# First-boot only. Existing database volumes are never changed by this script.
# psql reads secrets from its environment; neither command arguments nor output contain them.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password POSTGRES_PASSWORD
\getenv runtime_password APP_DATABASE_PASSWORD
SELECT :'migration_password' = :'runtime_password' AS passwords_match \gset
\if :passwords_match
\echo 'POSTGRES_PASSWORD and APP_DATABASE_PASSWORD must be different.'
SELECT 1 / 0;
\endif
CREATE ROLE signhere_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE ROLE signhere LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
SELECT format('ALTER ROLE signhere_migrator PASSWORD %L', :'migration_password') \gexec
SELECT format('ALTER ROLE signhere PASSWORD %L', :'runtime_password') \gexec
ALTER DATABASE signhere OWNER TO signhere_migrator;
REVOKE ALL ON DATABASE signhere FROM PUBLIC;
GRANT CONNECT ON DATABASE signhere TO signhere;
ALTER SCHEMA public OWNER TO signhere_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO signhere;
ALTER DEFAULT PRIVILEGES FOR ROLE signhere_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO signhere;
ALTER DEFAULT PRIVILEGES FOR ROLE signhere_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO signhere;
-- The bootstrap superuser is available only through local container administration.
ALTER ROLE postgres PASSWORD NULL;
SQL
