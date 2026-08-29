-- standalone_057_audit_log_authenticated_read 回滚
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚后回到 standalone_056 前水平（audit_log 仅 service_role 可读）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP POLICY IF EXISTS ewoh_audit_select_authenticated ON __EWOH_SCHEMA__.ewoh_audit_log;
REVOKE SELECT ON TABLE __EWOH_SCHEMA__.ewoh_audit_log FROM authenticated;

SELECT 1 AS standalone_057_rollback_verified;
