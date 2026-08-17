-- standalone_008_phase2_realtime verify（审计 SQL-103 补齐，2026-08-17）。
-- Schema: __EWOH_SCHEMA__（runner substitute 注入 public）。
-- 断言 ewoh_outbox 实时闭环列与索引已就位：entity_type / entity_version 列 +
-- idx_ewoh_outbox_sequence 索引（SSE 缺口检测 / ImpactAnalyzer 分类依据）。
-- 注意：008/017 顺序兼容（审计 SQL-003）后，空库链上这些对象由 017 建表时
-- 直接带出（008 守卫跳过）；本 verify 断言最终形态，与创建者无关。
-- 形态：DO 块自证 + 单行 standalone_008_verified（--verify-standalone-phase2-realtime 断言 =1）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  v_entity_cols bigint;
  v_sequence_index bigint;
BEGIN
  SELECT count(*) INTO v_entity_cols
    FROM information_schema.columns
   WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_outbox'
     AND column_name IN ('entity_type', 'entity_version');
  IF v_entity_cols <> 2 THEN
    RAISE EXCEPTION 'verify standalone_008: ewoh_outbox 缺 entity 列（期望 2 列，实际 %）', v_entity_cols;
  END IF;

  SELECT count(*) INTO v_sequence_index
    FROM pg_indexes
   WHERE schemaname = '__EWOH_SCHEMA__' AND tablename = 'ewoh_outbox'
     AND indexname = 'idx_ewoh_outbox_sequence';
  IF v_sequence_index <> 1 THEN
    RAISE EXCEPTION 'verify standalone_008: idx_ewoh_outbox_sequence 索引缺失';
  END IF;
END $$;

SELECT 1 AS standalone_008_verified;
