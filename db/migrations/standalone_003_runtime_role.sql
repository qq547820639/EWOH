-- EWOH standalone non-owner runtime role
-- Password is injected by db/runner/run_migrations.js and is never committed.
DO $ewoh_api_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ewoh_api') THEN
    CREATE ROLE ewoh_api LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$ewoh_api_role$;

ALTER ROLE ewoh_api
  WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD '__EWOH_API_DATABASE_PASSWORD__';
GRANT service_role TO ewoh_api;
ALTER ROLE ewoh_api SET search_path TO public, pg_temp;
