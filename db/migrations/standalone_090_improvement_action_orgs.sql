-- EWOH 行动项逾期提醒 worker 的租户清单函数 (standalone_090, NO-56b)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE OR REPLACE FUNCTION（幂等可重复执行）。
--
-- 为什么需要：后台 worker 没有请求上下文 → 没有 app.current_org_id GUC →
-- 直接查 ewoh_improvement_action 会被 RLS 全部挡住，表现为"worker 静默 0 条提醒"
-- （NO-37a/NO-48a/NO-53a 已在会话提醒、安灯升级、数据质量提醒上各踩过一次）。
-- 因此租户清单必须走**受控 SECURITY DEFINER 函数**：只返回 org_id，不返回业务明细；
-- 明细在逐租户 GUC 事务里读，租户隔离照旧生效。
--
-- 回滚语义：DROP FUNCTION（worker 停用即可，业务表不受影响）。

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_improvement_action_orgs()
RETURNS TABLE(org_id varchar)
LANGUAGE sql
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
  SELECT DISTINCT a.org_id
  FROM __EWOH_SCHEMA__.ewoh_improvement_action a
  WHERE a.status = 'accepted'
    AND a.due_at IS NOT NULL
  ORDER BY a.org_id;
$$;

COMMENT ON FUNCTION __EWOH_SCHEMA__.ewoh_improvement_action_orgs() IS
  '有"已接受且设了期限"行动项的租户清单（NO-56b 逾期提醒 worker 用）。SECURITY DEFINER，只返回 org_id，不返回业务明细。';

REVOKE ALL ON FUNCTION __EWOH_SCHEMA__.ewoh_improvement_action_orgs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_improvement_action_orgs() TO service_role;
