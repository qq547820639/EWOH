-- EWOH 改进行动项"闭环证据回流"落点 (standalone_091, NO-57c)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS / 幂等可重复执行。
--
-- 背景（§9 学习回路）：行动项完成后，结果说明与验收事实此前只留在行动项自己那一行，
-- **没有回流成可复用知识**——下一班遇到同类问题仍要从零判断。
--   1) `outcome_ref`：完成时写入的知识条目号（`ewoh_knowledge_entry.entry_id`）；
--      为空 = 未回流（页面必须显式显示"未回流"，不许看起来像"已完成且已归档"）；
--   2) `outcome_kind`：回流产物类型（当前仅 'knowledge_entry'，封闭词表）；
--   3) CHECK：outcome_ref 与 outcome_kind 必须同时有或同时无（半成品不允许落库）；
--      且只有 completed 才能带回流引用（未完成不许假装已归档）。
--
-- 回滚语义：DROP COLUMN（additive；历史值丢失前应先导出）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
  ADD COLUMN IF NOT EXISTS outcome_ref varchar(255),
  ADD COLUMN IF NOT EXISTS outcome_kind varchar(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ewoh_improvement_action_outcome_pair'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
      ADD CONSTRAINT chk_ewoh_improvement_action_outcome_pair
      CHECK (
        (outcome_ref IS NULL AND outcome_kind IS NULL)
        OR (outcome_ref IS NOT NULL AND length(btrim(outcome_ref)) > 0
            AND outcome_kind IS NOT NULL AND outcome_kind IN ('knowledge_entry'))
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ewoh_improvement_action_outcome_completed'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
      ADD CONSTRAINT chk_ewoh_improvement_action_outcome_completed
      CHECK (outcome_ref IS NULL OR status = 'completed');
  END IF;
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.outcome_ref IS
  '完成时回流的知识条目号（ewoh_knowledge_entry.entry_id）；NULL = 未回流（页面必须显式显示，不许当成已归档）';
