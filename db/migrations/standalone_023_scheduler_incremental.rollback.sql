-- EWOH Command Map 智能调度升级 — standalone_023 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- DROP COLUMN IF EXISTS / DROP INDEX IF EXISTS / DROP POLICY IF EXISTS（幂等可重复执行）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) ewoh_scheduling_constraint 新列
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP COLUMN IF EXISTS valid_from_ms;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP COLUMN IF EXISTS expires_at_ms;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP COLUMN IF EXISTS org_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP COLUMN IF EXISTS source;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP COLUMN IF EXISTS deactivated_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP COLUMN IF EXISTS deactivated_by;

-- 2) ewoh_schedule_plan 新列
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP COLUMN IF EXISTS constraints_json;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP COLUMN IF EXISTS effective_constraints_hash;

-- 3) ewoh_spatial_entity 新列
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  DROP COLUMN IF EXISTS coordinate_type;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  DROP COLUMN IF EXISTS floor_id;

-- 4) ewoh_device 新列
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  DROP COLUMN IF EXISTS location_coordinate_type;

-- 5) 索引
DROP INDEX IF EXISTS idx_constraint_org_active;
DROP INDEX IF EXISTS idx_constraint_expiry;
DROP INDEX IF EXISTS idx_schedule_plan_constraint_hash;

-- 6) RLS policy
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;
