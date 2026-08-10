-- EWOH Command Map — standalone_024_scheduler_outbox_notify 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 顺序：先 drop trigger 再 drop function（依赖顺序）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TRIGGER IF EXISTS trg_scheduler_outbox_notify ON __EWOH_SCHEMA__.ewoh_outbox;
DROP FUNCTION IF EXISTS notify_scheduler_outbox();
