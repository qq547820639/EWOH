-- ============================================================================
-- 维护脚本：任务时间窗平移（EWOH 演示平台数据保鲜）
--
-- 背景：演示平台的 seed 任务时间窗（ewoh_production_task / ewoh_schedule_task）
-- 是固定历史时间（如 2026-08-17），平台运行数天后全部过期，导致：
--   * 调度（MANUAL）时所有任务 time_conflict → 无可用资源 → metrics 全 0 /
--     assignments 极少（"方案数字全是 0"问题的根因之一）。
--
-- 用法（在 ECS 上执行）：
--   docker exec -i ewoh-postgres psql -U ewoh_owner -d ewoh -f - < scripts/maintain-shift-task-windows.sql
--
-- 效果：把两张任务表的 plan_start/plan_end 整体平移，使最早任务落在
-- now() + 5min（保持任务间相对间隔不变）。
-- ============================================================================

BEGIN;

-- 1) ewoh_production_task（调度快照任务数据源，SSOT）
UPDATE ewoh_production_task
SET plan_start = plan_start + ((now() + interval '5 minutes') - (SELECT min(plan_start) FROM ewoh_production_task WHERE plan_start IS NOT NULL)),
    plan_end   = plan_end   + ((now() + interval '5 minutes') - (SELECT min(plan_start) FROM ewoh_production_task WHERE plan_start IS NOT NULL))
WHERE plan_start IS NOT NULL;

-- 2) ewoh_schedule_task（调度任务台账，同步平移保持一致）
UPDATE ewoh_schedule_task
SET plan_start = plan_start + ((now() + interval '5 minutes') - (SELECT min(plan_start) FROM ewoh_schedule_task WHERE deleted_at IS NULL AND plan_start IS NOT NULL)),
    plan_end   = plan_end   + ((now() + interval '5 minutes') - (SELECT min(plan_start) FROM ewoh_schedule_task WHERE deleted_at IS NULL AND plan_start IS NOT NULL))
WHERE deleted_at IS NULL AND plan_start IS NOT NULL;

COMMIT;

-- 验证（应看到 plan_start 落在当前时间之后）：
-- SELECT id, to_char(plan_start,'MM-DD HH24:MI') AS pstart, to_char(plan_end,'MM-DD HH24:MI') AS pend
-- FROM ewoh_production_task WHERE plan_start IS NOT NULL ORDER BY plan_start LIMIT 5;
