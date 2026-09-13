-- 091 rollback：移除行动项的回流引用列（additive；回滚前应先导出 outcome_ref/outcome_kind）。

ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
  DROP CONSTRAINT IF EXISTS chk_ewoh_improvement_action_outcome_pair,
  DROP CONSTRAINT IF EXISTS chk_ewoh_improvement_action_outcome_completed,
  DROP COLUMN IF EXISTS outcome_ref,
  DROP COLUMN IF EXISTS outcome_kind;
