-- EWOH Maintenance / Quality — standalone_034 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 034 为两张全新表（additive）：回滚 = DROP TABLE（索引/约束/RLS 随表级联删除）。
-- 幂等可重复执行（IF EXISTS）；不影响既有数据流。
-- apply → rollback → re-apply 循环安全（CREATE TABLE IF NOT EXISTS）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_quality_finding;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_maintenance_condition;
