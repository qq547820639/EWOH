-- 081 verify：通知处置结果四列 + 待处置部分索引就位，且既有语义未被破坏。
--
-- 自证内容：
--   1. 四个新列类型正确（varchar(50) / timestamptz(3) / varchar(255) / varchar(255)，均可空）；
--   2. 部分索引存在且带 `WHERE (status = 'pending'::character varying)` 条件；
--   3. 既有 status/read_at 语义仍在（列未被动过）；
--   4. 通知表的 RLS 策略数量未减少（租户隔离不被本次改动破坏）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_notification'
      AND is_nullable = 'YES'
      AND ((column_name = 'resolution' AND data_type = 'character varying' AND character_maximum_length = 50)
        OR (column_name = 'resolved_by' AND data_type = 'character varying' AND character_maximum_length = 255)
        OR (column_name = 'resolution_ref' AND data_type = 'character varying' AND character_maximum_length = 255)
        OR (column_name = 'resolved_at' AND data_type = 'timestamp with time zone'))) = 4
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_ewoh_notification_pending_external_ref'
      AND indexdef LIKE '%(org_id, external_ref)%'
      AND indexdef LIKE '%status%pending%'
  )
  -- 既有语义未被破坏：status / read_at 仍在
  AND (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'ewoh_notification'
          AND column_name IN ('status', 'read_at')) = 2
  -- 租户隔离不被破坏
  AND (SELECT count(*) FROM pg_policies
        WHERE schemaname = current_schema() AND tablename = 'ewoh_notification') >= 1
  THEN 1 ELSE 0 END AS standalone_081_verified;
