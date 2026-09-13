-- EWOH 待投递命令的租户清单函数（NO-68a）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE OR REPLACE FUNCTION + 幂等 GRANT/REVOKE。
--
-- 背景：投递积压（命令 `sent` 超过 SLA 仍未交付网关）需要**后台定时提醒**，
-- 但后台 worker 没有请求上下文 → 无 GUC → 直接查业务表会被 RLS 全部挡住
-- （表现为"worker 静默 0 条"，本仓库已多次踩到，见 `ewoh_improvement_action_orgs` 等同款函数）。
-- 因此按既有纪律提供**只返回 org_id** 的 SECURITY DEFINER 函数：明细仍在逐租户 GUC 事务里读，
-- 函数本身不暴露任何业务字段。
--
-- 与既有函数同款安全姿态：
--   · 只返回 org_id（无设备号/命令内容）；
--   · REVOKE ALL FROM PUBLIC + 仅 service_role 可执行（anon/authenticated 不可见）；
--   · search_path 固定（防搜索路径注入）。
--
-- 回滚语义：DROP FUNCTION。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_control_pending_orgs()
RETURNS TABLE(org_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
  SELECT DISTINCT c.org_id
    FROM __EWOH_SCHEMA__.ewoh_control_command c
   WHERE c.status = 'sent'
     AND c.org_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION __EWOH_SCHEMA__.ewoh_control_pending_orgs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_control_pending_orgs() TO service_role;

COMMENT ON FUNCTION __EWOH_SCHEMA__.ewoh_control_pending_orgs() IS
  '待投递（status=sent）控制命令的租户清单（只返回 org_id；后台提醒 worker 用，NO-68a）';
