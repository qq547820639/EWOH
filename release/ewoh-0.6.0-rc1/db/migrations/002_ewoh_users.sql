-- EWOH user table for standalone cloud auth
-- Schema placeholder: __EWOH_SCHEMA__

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(255) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name varchar(255),
  org_id uuid NOT NULL,
  roles jsonb NOT NULL DEFAULT '["viewer"]'::jsonb,
  is_global_admin boolean NOT NULL DEFAULT false,
  status varchar(50) NOT NULL DEFAULT 'active',
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_user_org ON __EWOH_SCHEMA__.ewoh_user(org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_user_status ON __EWOH_SCHEMA__.ewoh_user(status);

ALTER TABLE __EWOH_SCHEMA__.ewoh_user ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_user FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_user FROM
  anon_workspace_aadknm4yzbyds,
  authenticated_workspace_aadknm4yzbyds,
  user_authenticated_workspace_aadknm4yzbyds,
  service_role_workspace_aadknm4yzbyds;

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(p_username text)
RETURNS TABLE (
  username varchar(255),
  password_hash text,
  org_id uuid,
  roles jsonb,
  is_global_admin boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
ROWS 1
AS $$
  SELECT u.username, u.password_hash, u.org_id, u.roles, u.is_global_admin
  FROM __EWOH_SCHEMA__.ewoh_user AS u
  WHERE u.username = p_username AND u.status = 'active'
  LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_find_active_user(text)
  TO service_role_workspace_aadknm4yzbyds;
