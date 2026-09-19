-- EWOH 死信 reason 注册表扩容：clock_drift_future / event_write_failed（NO-68g）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: DROP+ADD CONSTRAINT 幂等（约束定义含全量清单，重复执行同果）。
--
-- 背景（2026-09-15 仿真对抗行为级探针实测）：`/api/ingest/events` 的坏时钟拒绝
-- 与事件写库失败会走 DeadLetterService.record（reason='clock_drift_future' /
-- 'event_write_failed'），但该 reason 不在 ewoh_dead_letter 的 CHECK 约束白名单
-- 里——死信落账 INSERT 必然违反 chk_ewoh_dead_letter_reason。此前的三层投影
-- （schema reasonRegistry / shared TS / edge Python）都改了，**DB 约束是第四个
-- 投影**：不改则应用层注册后落账从"静默吞掉"升级为"违约 500"（探针实测），
-- 依然没有死信行。本迁移把约束对齐三处代码投影，"落死信人审"承诺才能真正兑现。
--
-- 回滚语义：先删两类新 reason 的行，再恢复 043 的原始 5-reason 约束。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_dead_letter
  DROP CONSTRAINT IF EXISTS chk_ewoh_dead_letter_reason;

ALTER TABLE __EWOH_SCHEMA__.ewoh_dead_letter
  ADD CONSTRAINT chk_ewoh_dead_letter_reason
  CHECK (reason IN (
    'contract_violation', 'unknown_event_type', 'permanent_failure',
    'ttl_expired', 'max_attempts_exceeded',
    'clock_drift_future', 'event_write_failed'
  ));

COMMENT ON CONSTRAINT chk_ewoh_dead_letter_reason ON __EWOH_SCHEMA__.ewoh_dead_letter IS
  ' Canonical Dead Letter reason 封闭注册表（NO-68g 扩容：clock_drift_future / event_write_failed）；与 contracts/reliability/dead-letter.schema.json reasonRegistry 锁步';
