-- 096 rollback：移除待投递命令的租户清单函数。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_control_pending_orgs();
