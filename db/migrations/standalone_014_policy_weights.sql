-- EWOH Command Map 智能调度驾驶舱 — Solver Objective 8 权重版本化 (Phase 2 / P2-T2)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE ... ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（02 §11 / P2-T2）：SchedulingPolicy 目标权重权威化——完整 8 权重
-- (W_lateness/W_travel/W_wait/W_workload/W_station/W_change/W_risk/W_energy) 落库
-- ewoh_scheduling_policy.weights_json，替代 buildPolicy 魔法数派生；同时
-- ewoh_schedule_plan.weights_json 保存方案实际使用的权重快照（确定性 replay）。
-- 默认值缺省（NULL）→ 后端 resolveWeights 用默认常量兜底，旧配置向后兼容。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ===== ewoh_scheduling_policy =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy
  ADD COLUMN IF NOT EXISTS weights_json jsonb;

-- ===== ewoh_schedule_plan（方案权重快照） =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS weights_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_policy.weights_json IS '完整 8 权重权威对象 {lateness,travel,wait,workload,station,change,risk,energy}（缺省用默认常量，不再魔法数派生）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.weights_json IS '方案实际使用的权重快照（确定性 replay）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan TO service_role;
