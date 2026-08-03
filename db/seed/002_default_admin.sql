SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

INSERT INTO __EWOH_SCHEMA__.ewoh_user
  (username, password_hash, display_name, org_id, roles, is_global_admin, status)
SELECT
  '__EWOH_ADMIN_USERNAME__',
  '__EWOH_ADMIN_PASSWORD_HASH__',
  '__EWOH_ADMIN_DISPLAY_NAME__',
  COALESCE((SELECT org_id FROM __EWOH_SCHEMA__.ewoh_organization ORDER BY _created_at LIMIT 1), '00000000-0000-4000-8000-000000000001'::uuid),
  '["global_admin"]'::jsonb,
  true,
  'active'
ON CONFLICT (username) DO NOTHING;
