-- 102 rollback：移除积压历史快照表（派生观测数据，可重建）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_control_backlog_snapshot;
