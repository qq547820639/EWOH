-- 106 rollback：移除 sent 状态/时间配对约束（约束性加固；不删除业务事实）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
  DROP CONSTRAINT IF EXISTS chk_ewoh_control_command_sent_has_time;
