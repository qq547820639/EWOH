-- 085 rollback：移除交接班的责任人快照列（交接记录与遗留事项不受影响）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
ALTER TABLE __EWOH_SCHEMA__.ewoh_shift_handover DROP COLUMN IF EXISTS responsibility_snapshot_json;
