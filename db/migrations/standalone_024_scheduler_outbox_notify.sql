-- EWOH Command Map — Outbox → Postgres LISTEN/NOTIFY 低延迟 wake-up (Task 6, standalone_024)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS（幂等可重复执行）。
--
-- 背景（Task 6）：SchedulerStreamService 目前每 2s 轮询 ewoh_outbox 推送 SSE 事件，
-- 事件提交到 SSE 存在至多 ~2s 的延迟。本迁移在 ewoh_outbox 上新增行级 AFTER INSERT trigger：
--   - 有行插入（事务提交后）→ pg_notify('scheduler_outbox', '')；
--   - SchedulerStreamService 侧 LISTEN 该频道，收到通知即触发一次 poll（低延迟 wake-up）。
--
-- 语义边界（NOTIFY 不是唯一事实源）：
--   - AFTER INSERT 触发器的 pg_notify 在事务提交后才实际送达监听方，不会暴露未提交脏行；
--   - 事件可靠性仍由 durable outbox + sequence + replay/gap 语义保证；
--   - LISTEN 连接失败自动回退纯 polling（2s 轮询兜底），本迁移缺失也不影响现状行为。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) 通知函数：新行写入后广播空载荷通知（频道名与 SchedulerStreamService LISTEN 侧一致）。
CREATE OR REPLACE FUNCTION notify_scheduler_outbox() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('scheduler_outbox', '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) 行级 AFTER INSERT trigger（幂等：先 DROP IF EXISTS 再 CREATE）。
DROP TRIGGER IF EXISTS trg_scheduler_outbox_notify ON __EWOH_SCHEMA__.ewoh_outbox;
CREATE TRIGGER trg_scheduler_outbox_notify
  AFTER INSERT ON __EWOH_SCHEMA__.ewoh_outbox
  FOR EACH ROW EXECUTE FUNCTION notify_scheduler_outbox();
