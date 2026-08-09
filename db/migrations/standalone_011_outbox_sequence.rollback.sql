-- EWOH Command Map 智能调度驾驶舱 — outbox sequence rollback (B1 修复)
-- DESTRUCTIVE-optional: 移除 sequence 并还原 ewoh_outbox.sequence 默认值。
-- Guarded with IF EXISTS / DROP DEFAULT for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox
  ALTER COLUMN sequence DROP DEFAULT;

DROP SEQUENCE IF EXISTS __EWOH_SCHEMA__.ewoh_outbox_sequence_seq;
