-- standalone_048_shadow_plan_isolation 回滚（约束为 additive 纵深防御）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚 = DROP CONSTRAINT（服务端 hard guard + is_shadow 标识仍在，回滚后
-- 回到迁移前防线水平；不影响任何行数据）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP CONSTRAINT IF EXISTS chk_ewoh_schedule_plan_shadow_not_production;
