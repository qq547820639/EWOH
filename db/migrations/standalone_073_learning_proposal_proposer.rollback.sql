-- standalone_073 回滚：移除生成人回避 CHECK 与 ewoh_learning_proposal.proposed_by。
-- 数据损失：存量提案人记录将删除（仅用于迁移链验证，生产禁用）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_learning_proposal'::regclass
      AND conname = 'chk_ewoh_learning_proposal_generator_avoidance'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_proposal
      DROP CONSTRAINT chk_ewoh_learning_proposal_generator_avoidance;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_learning_proposal'
      AND column_name = 'proposed_by'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_proposal DROP COLUMN proposed_by;
  END IF;
END $$;
