-- EWOH Command Map 智能调度 — 资源时间窗真实交集：设备维护窗口列 (Phase 1 / P1-A, standalone_027)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（spec §P1-A / Task 1）：候选可用性此前主要来自 reservation 扣减；设备无维护窗口
-- 时间语义。本迁移为 ewoh_device 新增真实维护时间窗列（epoch ms 区间）：
--   maintenance_start_ms / maintenance_end_ms
-- 两列均为 NULL（无维护计划）时应用层不产生维护窗口约束（缺数据不伪造）。
-- 仅新增列 + 注释，不删除既有列/索引（向后兼容，与 023/025/026 同风格）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_device：维护时间窗（bigint epoch ms；nullable，存量行 NULL=无维护计划）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS maintenance_start_ms bigint;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS maintenance_end_ms bigint;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.maintenance_start_ms IS '设备维护开始时间（epoch ms；null=无维护计划，不产生维护窗口约束）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.maintenance_end_ms IS '设备维护结束时间（epoch ms；null=无维护计划，不产生维护窗口约束）';
