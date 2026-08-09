-- EWOH Command Map 智能调度驾驶舱 — 领域模型新列 rollback (Phase 1 / P1-T1)
-- DESTRUCTIVE-optional: 移除 012 新增的全部列与索引。
-- Guarded with DROP COLUMN IF EXISTS / DROP INDEX IF EXISTS for re-entrancy.
-- 注意：rollback 会丢弃这些列中已写入的真实业务数据（预期行为，谨慎执行）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ===== 索引（先删索引，避免与列删除冲突） =====
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_production_task_safety;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_personnel_current_task;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_scheduling_run_failure;

-- ===== ewoh_production_task =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS base_priority;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS earliest_start_ms;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS latest_finish_ms;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS safety_critical;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS preemptible;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS skill_match_mode;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS production_impact;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS downstream_impact;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS required_station_capabilities;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS preferred_resources;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS excluded_resources;

-- ===== ewoh_personnel =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS shift;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS workload;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS current_task_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS certification_expiry;

-- ===== ewoh_device =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS capabilities;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS location_lat;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS location_lng;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS location_updated_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS location_confidence;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS telemetry_updated_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DROP COLUMN IF EXISTS available_windows;

-- ===== ewoh_spatial_entity =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity DROP COLUMN IF EXISTS capacity;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity DROP COLUMN IF EXISTS queue;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity DROP COLUMN IF EXISTS available_windows;

-- ===== ewoh_scheduling_run =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run DROP COLUMN IF EXISTS failure_reason;
