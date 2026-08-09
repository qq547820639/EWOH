-- EWOH Command Map 智能调度驾驶舱 — outbox sequence (B1 修复)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE SEQUENCE IF NOT EXISTS / ALTER COLUMN SET DEFAULT.
--
-- 背景：outbox.service.ts nextSequence() 用 SELECT MAX(sequence)+1 生成序号，
-- 并发入队时非原子 → 可能重复/乱序。本迁移引入 DB 序列：
--   1. CREATE SEQUENCE ewoh_outbox_sequence_seq；
--   2. ewoh_outbox.sequence 列 DEFAULT 改为 nextval(序列)；
--   3. setval 对齐既有 MAX(sequence)（+1 且 is_called=false），
--      避免与历史行 sequence 冲突/乱序。
-- 此后入队不显式传 sequence 时由 DB DEFAULT 原子生成（单调递增）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE SEQUENCE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_outbox_sequence_seq;

ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox
  ALTER COLUMN sequence SET DEFAULT nextval('__EWOH_SCHEMA__.ewoh_outbox_sequence_seq');

SELECT setval(
  '__EWOH_SCHEMA__.ewoh_outbox_sequence_seq',
  COALESCE((SELECT MAX(sequence) FROM __EWOH_SCHEMA__.ewoh_outbox), 0) + 1,
  false
);

COMMENT ON SEQUENCE __EWOH_SCHEMA__.ewoh_outbox_sequence_seq IS 'Outbox event sequence: atomic nextval generator replacing non-atomic SELECT MAX+1';
