-- EWOH 2026-09-01 — 学习提案审批独立性数据地基（standalone_073，B5 同族治理）
-- 给 ewoh_learning_proposal 增加 proposed_by（提案提出者），并加生成人回避 CHECK。
-- 背景：审批独立性核实确认「策略阈值提案」存在结构性自批——表中只有
-- approved_by（审批人）与 rejected_by/rolled_back_by，无提议人字段，
-- 「提案人不得审批自己的提案」这一回避校验无从执行（与 standalone_069
-- 对 ewoh_schedule_plan.created_by 的处置同族，同一治理口径 B5）。
-- 本迁移补齐数据地基（列 + DB 层 CHECK 双保险）；提议路径写入与
-- approve 回避校验（ForbiddenException SELF_APPROVAL_FORBIDDEN）由应用层配合落地。
-- 幂等：DO 块按列/约束存在性守卫，重复执行无副作用。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_learning_proposal'
      AND column_name = 'proposed_by'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_proposal
      ADD COLUMN proposed_by varchar(128);
  END IF;
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_proposal.proposed_by IS
  '提案提出者（2026-09-01 B5 同族审批独立性治理；NULL=存量/legacy 行，回避校验对 NULL 放行，避免历史提案被永久锁死）';

-- 生成人回避（与 standalone_069 的应用层 guard 同语义，DB 层兜底）：
-- approved 行的审批人与提议人不得为同一身份。IS DISTINCT FROM 保证 NULL 安全
-- （approved_by 另有 chk_ewoh_learning_proposal_approval 要求非空）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_learning_proposal'::regclass
      AND conname = 'chk_ewoh_learning_proposal_generator_avoidance'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_proposal
      ADD CONSTRAINT chk_ewoh_learning_proposal_generator_avoidance CHECK (
        status <> 'approved'
        OR proposed_by IS NULL
        OR approved_by IS DISTINCT FROM proposed_by
      );
  END IF;
END $$;
