-- standalone_103_workbench_query_indexes 回滚（需 EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1）。
-- 不回滚 pg_trgm 扩展：其他索引/扩展消费者可能依赖；可按部署策略显式移除。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_schedule_task_step_org_status_name_trgm;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_schedule_task_org_status_plan_end;
