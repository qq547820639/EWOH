-- EWOH Command Map 智能调度驾驶舱 — Solver Objective 8 权重版本化 rollback (Phase 2 / P2-T2)
-- DESTRUCTIVE-optional: 移除 weights_json 列。
-- Guarded with DROP COLUMN IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy DROP COLUMN IF EXISTS weights_json;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS weights_json;
