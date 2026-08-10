-- EWOH Command Map — standalone_030 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 030 为 additive 可空列（无索引/触发器/外键依赖）：回滚直接 DROP COLUMN，
-- 幂等可重复执行（DROP COLUMN IF EXISTS）。
--
-- 语义：solver_status / fallback_reason 为审计/观测承载列，无生产引用
-- （无外键、无触发器、无 RLS 依赖），删除无副作用；apply → rollback → re-apply
-- 循环安全（ADD COLUMN IF NOT EXISTS 跳过已存在列，数据在 rollback 时随列删除）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP COLUMN IF EXISTS solver_status;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP COLUMN IF EXISTS fallback_reason;

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run
  DROP COLUMN IF EXISTS solver_status;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run
  DROP COLUMN IF EXISTS fallback_reason;
