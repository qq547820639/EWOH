-- standalone_061 回滚：移除 (org_id, ts) 复合索引（恢复 Seq Scan 缺陷态，
-- 仅用于迁移链验证，生产禁用）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_telemetry_org_ts;
