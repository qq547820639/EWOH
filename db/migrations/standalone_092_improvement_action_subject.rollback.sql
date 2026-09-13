-- 092 rollback：移除行动项对象归属列（additive；回滚前应先导出 subject_type/subject_id）。

ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action
  DROP CONSTRAINT IF EXISTS chk_ewoh_improvement_action_subject_pair,
  DROP COLUMN IF EXISTS subject_type,
  DROP COLUMN IF EXISTS subject_id;
