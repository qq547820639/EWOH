-- standalone_103_workbench_query_indexes：班次工作台大数据查询索引
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE EXTENSION IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP INDEX IF EXISTS。
--
-- 背景：100k 行 perf 门禁显示 delayedOrders 仍扫描 20k 行，mySteps 前缀通配
-- 搜索扫描步骤表。前者用 (org_id, status, plan_end) 复合索引；后者需要
-- pg_trgm GIN 索引支持 ILIKE '%term%'。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_org_status_plan_end
  ON __EWOH_SCHEMA__.ewoh_schedule_task (org_id, status, plan_end)
  INCLUDE (schedule_task_id, title);

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_step_org_status_name_trgm
  ON __EWOH_SCHEMA__.ewoh_schedule_task_step
  USING gin (name gin_trgm_ops)
  WHERE org_id IS NOT NULL;
