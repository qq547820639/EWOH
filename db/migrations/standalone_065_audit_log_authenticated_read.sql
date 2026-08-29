-- standalone_057_audit_log_authenticated_read: ewoh_audit_log 认证读策略
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: DROP POLICY IF EXISTS / CREATE POLICY（幂等可重复执行）。
--
-- 背景：ewoh_audit_log 当前仅 service_role 可读（write-only 设计防止
-- 前端直接读取审计日志）。standalone_057 为 authenticated 角色添加
-- 只读策略（org 过滤），支持前端审计页面按租户查询审计记录。
-- 写入仍由 service_role 通过 ewoh_append_audit_log 函数完成。
-- GRANT SELECT 为 additive（不触碰 service_role 现有权限）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) GRANT SELECT TO authenticated（additive，不触碰 service_role）。
GRANT SELECT ON TABLE __EWOH_SCHEMA__.ewoh_audit_log TO authenticated;

-- 2) 新增认证读策略（org 过滤：ewoh_org_visible 匹配或 global_admin）。
DROP POLICY IF EXISTS ewoh_audit_select_authenticated ON __EWOH_SCHEMA__.ewoh_audit_log;
CREATE POLICY ewoh_audit_select_authenticated
  ON __EWOH_SCHEMA__.ewoh_audit_log
  FOR SELECT
  TO authenticated
  USING (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id)
    OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true')
  );

COMMENT ON POLICY ewoh_audit_select_authenticated ON __EWOH_SCHEMA__.ewoh_audit_log IS
  '审计日志认证读策略（standalone_057）：org 过滤（ewoh_org_visible 匹配或 global_admin）';

-- 3) 验证策略创建成功（SAVEPOINT 自证）。
DO $$
DECLARE
  pol_count integer := 0;
BEGIN
  SELECT count(*) INTO pol_count FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'ewoh_audit_log'
      AND policyname = 'ewoh_audit_select_authenticated';
  IF pol_count != 1 THEN
    RAISE EXCEPTION 'standalone_057 verify failed: ewoh_audit_select_authenticated policy not found';
  END IF;
END $$;

SELECT 1 AS standalone_057_verified;
