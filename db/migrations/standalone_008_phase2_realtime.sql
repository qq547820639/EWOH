-- EWOH Scheduling V2 Phase 2 — real-time closed-loop (Task 2.1)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- Adds entity_type / entity_version to ewoh_outbox so scheduling events carry the
-- entity type and its world-state version, enabling SSE gap detection and the
-- ImpactAnalyzer to classify events (RESOURCE_OFFLINE / RESERVATION_CONFLICT /
-- PLAN_STALE / ROUTE_BLOCKED) by the target entity.
--
-- 迁移顺序兼容（审计 SQL-003 修复，2026-08-17）：ewoh_outbox 由
-- standalone_017_scheduling_tables_fix.sql 补建（017 编号晚于 008）。空库按
-- 文件名顺序执行时本迁移先于 017 运行——对可能不存在的表全部使用
-- ALTER TABLE IF EXISTS / DO $$ to_regclass 守卫：表不存在时静默跳过，
-- 017 的 CREATE TABLE 已包含本迁移的列与索引的最终形态；已应用库重跑
-- 时表已存在，行为与原迁移一致（幂等无变更）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_outbox ADD COLUMN IF NOT EXISTS entity_type varchar(100);
ALTER TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_outbox ADD COLUMN IF NOT EXISTS entity_version integer;

DO $$
BEGIN
  IF to_regclass('__EWOH_SCHEMA__.ewoh_outbox') IS NOT NULL THEN
    EXECUTE 'COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outbox.entity_type IS ''Entity type (device/person/task/route/zone...) referenced by entity_id''';
    EXECUTE 'COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outbox.entity_version IS ''World-state version of entity_id at trigger time''';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_sequence ON __EWOH_SCHEMA__.ewoh_outbox (sequence)';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_outbox TO service_role';
  END IF;
END $$;
