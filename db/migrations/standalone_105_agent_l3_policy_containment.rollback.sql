-- standalone_105 回滚策略：有意 no-op。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 本迁移隔离的是会绕过审批的不合规 L3 清单；自动恢复这些清单会重建安全风险。
-- 如业务确认要恢复，必须由管理员按当前契约注册新版本，而不是回滚策略遏制。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT 1 AS standalone_105_rollback_noop_verified;
