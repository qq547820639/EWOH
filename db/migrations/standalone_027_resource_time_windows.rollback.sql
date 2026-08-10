-- EWOH Command Map 智能调度 — standalone_027 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 仅移除维护时间窗列（幂等可重复执行）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  DROP COLUMN IF EXISTS maintenance_start_ms;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  DROP COLUMN IF EXISTS maintenance_end_ms;
