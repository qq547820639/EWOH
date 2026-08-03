#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const USER_PROFILE_DEFAULT =
  "__EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)";
const ROLE_BOOTSTRAP = `DO $ewoh_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$ewoh_roles$;`;
const RUNTIME_ROLE_MIGRATION = `-- EWOH standalone non-owner runtime role
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
`;
const RUNTIME_ROLE_ROLLBACK = `-- EWOH standalone runtime role rollback
-- DESTRUCTIVE: fails if ewoh_api still owns objects or has active sessions.
DROP ROLE IF EXISTS ewoh_api;
`;

function standaloneTransform(sql, options = {}) {
  let text = sql.split(USER_PROFILE_DEFAULT).join('uuid DEFAULT NULL');
  text = text.replace(/DO \$ewoh_type\$[\s\S]*?\$ewoh_type\$;/g, '');
  text = text
    .split('user_authenticated_workspace_aadknm4yzbyds').join('authenticated')
    .split('authenticated_workspace_aadknm4yzbyds').join('authenticated')
    .split('anon_workspace_aadknm4yzbyds').join('anon')
    .split('service_role_workspace_aadknm4yzbyds').join('service_role')
    .split('__EWOH_SCHEMA__').join('public')
    .split('workspace_aadknm4yzbyds').join('public');
  if (options.bootstrapRoles) {
    text = text.replace(
      "SELECT set_config('search_path', 'public, pg_temp', false);",
      `SELECT set_config('search_path', 'public, pg_temp', false);\n\n${ROLE_BOOTSTRAP}`,
    );
  }
  return text;
}

function renderStandaloneRollback(schemaSql) {
  const tables = [...schemaSql.matchAll(/^CREATE TABLE IF NOT EXISTS public\.([a-z0-9_]+)\s*\(/gm)]
    .map((match) => match[1]);
  if (tables.length === 0) {
    throw new Error('No standalone tables found while generating rollback SQL');
  }

  return [
    '-- EWOH standalone schema rollback',
    '-- DESTRUCTIVE: drops every table created by standalone_001_schema.sql.',
    '-- Shared cluster roles (anon, authenticated, service_role) are intentionally retained.',
    "SELECT set_config('search_path', 'public, pg_temp', false);",
    '',
    ...tables.reverse().map((table) => `DROP TABLE IF EXISTS public.${table} CASCADE;`),
    'DROP FUNCTION IF EXISTS public.ewoh_append_audit_log(uuid, text, text, text, text, jsonb, jsonb, text, text, text, boolean, text);',
    'DROP FUNCTION IF EXISTS public.ewoh_org_visible(uuid);',
    '',
  ].join('\n');
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content) {
  fs.writeFileSync(path.join(root, relative), content);
  console.log(`written ${relative}`);
}

const standaloneSchema = standaloneTransform(read('db/migrations/001_ewoh_managed_tables.sql'), {
  bootstrapRoles: true,
});

write('db/migrations/standalone_001_schema.sql', standaloneSchema);
write('db/migrations/standalone_001_schema.rollback.sql', renderStandaloneRollback(standaloneSchema));
write('db/verify/standalone_001_verify.sql', standaloneTransform(read('db/verify/001_verify.sql')));
write('db/seed/standalone_001_seed.sql', standaloneTransform(read('db/seed/001_demo_seed.sql')));
write('db/migrations/standalone_002_users.sql', standaloneTransform(read('db/migrations/002_ewoh_users.sql')));
write(
  'db/migrations/standalone_002_users.rollback.sql',
  standaloneTransform(read('db/migrations/002_ewoh_users.rollback.sql')),
);
write('db/migrations/standalone_003_runtime_role.sql', RUNTIME_ROLE_MIGRATION);
write('db/migrations/standalone_003_runtime_role.rollback.sql', RUNTIME_ROLE_ROLLBACK);
write('db/seed/standalone_002_admin.sql', standaloneTransform(read('db/seed/002_default_admin.sql')));
