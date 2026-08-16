-- EWOH Canonical Industrial Identity — standalone_032 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 032 为全新表 + telemetry 可空新列（additive）：
--   回滚 = DROP TABLE ewoh_identity_mapping（约束/索引/RLS 随表级联删除）+
--          DROP COLUMN ewoh_telemetry.entity_id + DROP INDEX。
-- 幂等可重复执行（IF EXISTS）；不影响既有数据流（未映射遥测 entity_id 恒 NULL）。
-- apply → rollback → re-apply 循环安全（CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_telemetry_entity_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry DROP COLUMN IF EXISTS entity_id;

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_identity_mapping;
