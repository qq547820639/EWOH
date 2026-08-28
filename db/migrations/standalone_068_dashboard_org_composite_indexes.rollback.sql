-- standalone_068_dashboard_org_composite_indexes 回滚（re-entrant；需 EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 回滚语义：仅删索引（纯 additive 变更，无行数据、无列变更、无 policy），
-- dashboard 未命中缓存路径回到单列 org_id 索引的全量扫描水平（审计 T6
-- 所指慢路径）。可随时重新 apply。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_event_org_status_severity;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_telemetry_org_ts_load;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_device_org_online;
