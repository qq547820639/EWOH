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

-- 设计意图（审计 SQL-051 文档化，2026-08-17，spec 已裁决项）：ewoh_user 刻意
-- 「RLS 启用 + 无 policy + REVOKE ALL」= 对全部角色全拒（fail-closed）。凭据
-- 校验只经下方 SECURITY DEFINER 函数 ewoh_find_active_user 受控读取（显式
-- GRANT），任何角色（含 service_role）不得直接 SELECT 密码哈希列。
ALTER TABLE public.ewoh_user ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ewoh_user FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.ewoh_user FROM
  anon,
  authenticated,
  authenticated,
  service_role;

-- 幂等守卫（2026-09-11 修复：链重跑失败 "cannot change return type"）：
-- standalone_072_user_person_binding 会 DROP 并以 6 列形态（+person_id）重建
-- 本函数。PostgreSQL 不允许 CREATE OR REPLACE 改变返回类型，因此在已应用 072
-- 的库上重跑本迁移会失败。守卫语义：函数已存在时跳过（链序保证存在的形态
-- 不早于本迁移；最终形态归 072 所有），全新库按本迁移的 5 列基线创建。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ewoh_find_active_user'
  ) THEN
    CREATE FUNCTION public.ewoh_find_active_user(p_username text)
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
    AS $fn$
      SELECT u.username, u.password_hash, u.org_id, u.roles, u.is_global_admin
      FROM public.ewoh_user AS u
      WHERE u.username = p_username AND u.status = 'active'
      LIMIT 1;
    $fn$;
  END IF;
END $$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ewoh_find_active_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ewoh_find_active_user(text)
  TO service_role;

-- Org scope lookup used before request GUCs are set. SECURITY DEFINER lets the
-- non-owner runtime role resolve the hierarchy without bypassing row-level
-- security on business tables.
-- 同款幂等守卫（与 ewoh_find_active_user 同因：防 OR REPLACE 改返回类型失败）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ewoh_find_org'
  ) THEN
    CREATE FUNCTION public.ewoh_find_org(p_org_id uuid)
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
    AS $fn$
      SELECT o.id, o.org_id, o.parent_id
      FROM public.ewoh_organization AS o
      WHERE o.org_id = p_org_id OR o.id = p_org_id
      ORDER BY CASE WHEN o.parent_id IS NULL THEN 0 ELSE 1 END
      LIMIT 1;
    $fn$;
  END IF;
END $$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ewoh_find_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ewoh_find_org(uuid)
  TO service_role;

-- 同款幂等守卫。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ewoh_find_org_children'
  ) THEN
    CREATE FUNCTION public.ewoh_find_org_children(p_parent_id uuid)
    RETURNS TABLE (
      id uuid,
      org_id uuid,
      parent_id varchar(255)
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
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
    $fn$;
  END IF;
END $$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ewoh_find_org_children(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ewoh_find_org_children(uuid)
  TO service_role;
