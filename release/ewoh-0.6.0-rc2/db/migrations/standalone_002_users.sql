-- EWOH user table for standalone cloud auth
-- Schema placeholder: public

SELECT set_config('search_path', 'public, pg_temp', false);

CREATE TABLE IF NOT EXISTS public.ewoh_user (
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

CREATE INDEX IF NOT EXISTS idx_ewoh_user_org ON public.ewoh_user(org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_user_status ON public.ewoh_user(status);

ALTER TABLE public.ewoh_user ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ewoh_user FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.ewoh_user FROM
  anon,
  authenticated,
  authenticated,
  service_role;

CREATE OR REPLACE FUNCTION public.ewoh_find_active_user(p_username text)
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
SET search_path = public, pg_temp
ROWS 1
AS $$
  SELECT u.username, u.password_hash, u.org_id, u.roles, u.is_global_admin
  FROM public.ewoh_user AS u
  WHERE u.username = p_username AND u.status = 'active'
  LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ewoh_find_active_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ewoh_find_active_user(text)
  TO service_role;

-- Org scope lookup used before request GUCs are set. SECURITY DEFINER lets the
-- non-owner runtime role resolve the hierarchy without bypassing row-level
-- security on business tables.
CREATE OR REPLACE FUNCTION public.ewoh_find_org(p_org_id uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  parent_id varchar(255)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
ROWS 1
AS $$
  SELECT o.id, o.org_id, o.parent_id
  FROM public.ewoh_organization AS o
  WHERE o.org_id = p_org_id OR o.id = p_org_id
  ORDER BY CASE WHEN o.parent_id IS NULL THEN 0 ELSE 1 END
  LIMIT 1;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ewoh_find_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ewoh_find_org(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ewoh_find_org_children(p_parent_id uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  parent_id varchar(255)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.org_id, o.parent_id
  FROM public.ewoh_organization AS o
  WHERE o.parent_id = p_parent_id::text
     OR o.parent_id = (
       SELECT id::text
       FROM public.ewoh_organization
       WHERE org_id = p_parent_id
       ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END
       LIMIT 1
     )
  ORDER BY o.id;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ewoh_find_org_children(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ewoh_find_org_children(uuid)
  TO service_role;
