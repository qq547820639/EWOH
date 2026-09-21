-- standalone_104：事件置信度数据库范围约束。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- standalone_066 将 ewoh_event.confidence 声明为 ADR-009 的 [0,1] 事实置信度，
-- 但只建立了 numeric(5,4) 列；应用契约校验之外，数据库仍可能被旁路写入写入
-- 负值或大于 1 的值。NULL 继续表示“未声明”，不伪造成确定事实。
-- Re-entrant：约束存在检查后动态添加；ROLLBACK 只移除约束，不删数据列。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = current_schema()
       AND cls.relname = 'ewoh_event'
       AND con.conname = 'chk_ewoh_event_confidence_range'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_event
      ADD CONSTRAINT chk_ewoh_event_confidence_range
      CHECK (confidence IS NULL OR confidence >= 0 AND confidence <= 1);
  END IF;
END $$;

COMMENT ON CONSTRAINT chk_ewoh_event_confidence_range
  ON __EWOH_SCHEMA__.ewoh_event IS
  'ADR-009 事件置信度纵深防御：NULL=未声明；非空值必须位于 [0,1]（standalone_104）';
