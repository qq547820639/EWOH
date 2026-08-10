-- EWOH Command Map 智能调度 — Solver 激活阶梯持久化列 (Task A P0, standalone_030)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（Task A P0）：求解器激活阶梯（OFF/SHADOW/CANARY/PRODUCTION）需要把方案实际
-- 使用的求解器状态（solver_status）与回退/降级原因（fallback_reason）持久化到
-- ewoh_schedule_plan 与 ewoh_scheduling_run，供审计追溯与 UI 展示
-- （SchedulingPlanV2.solverStatus / fallbackReason 此前仅存在于内存方案，未落库）。
--
-- 语义（additive，advisory 列）：
--   - 两列均 nullable，不设默认值；存量行保持 NULL（无回退/未知状态显式标注缺数据）；
--   - solver_status varchar(32)：OPTIMAL / FEASIBLE / HEURISTIC / FALLBACK / TIMEOUT /
--     UNAVAILABLE 等 SolverStatus 取值；
--   - fallback_reason text：回退/降级原因（如 worker 不可达、超时、production_not_gated）；
--   - 不建立索引/触发器（按 plan_id / run_id 主键查询，无需额外索引；避免 DDL 负担）。
--
-- 注意：服务端 SOLVER 强制语义在应用层（SolverService 激活阶梯路由），本迁移仅提供
-- 持久化承载，绝不改变求解行为。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS solver_status varchar(32);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS fallback_reason text;

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run
  ADD COLUMN IF NOT EXISTS solver_status varchar(32);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run
  ADD COLUMN IF NOT EXISTS fallback_reason text;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.solver_status IS '实际使用的求解器状态（OPTIMAL/FEASIBLE/HEURISTIC/FALLBACK/TIMEOUT/UNAVAILABLE；求解激活阶梯路由产物）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.fallback_reason IS '回退/降级原因（如 CP-SAT worker 不可达、超时、production_not_gated；无回退为 NULL）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_run.solver_status IS '运行所用求解器状态（随方案求解写入；succeeded 后回填）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_run.fallback_reason IS '运行所用求解器回退/降级原因（无回退为 NULL）';
