-- standalone_019_kpi_replay 回滚（幂等）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_kpi;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_policy_replay;
