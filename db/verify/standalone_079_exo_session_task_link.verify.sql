-- 079 verify：会话↔任务关联列与索引就位，且 RLS 租户隔离未被破坏。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  -- task_id 列存在、可空（NULL = 未关联，不是"没有任务"）
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_exo_session'
      AND column_name = 'task_id'
      AND data_type = 'character varying'
      AND is_nullable = 'YES') = 1
  -- (org_id, task_id) 索引存在（按任务回查会话）
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_ewoh_exo_session_task'
      AND indexdef LIKE '%(org_id, task_id)%'
  )
  -- 无外键：任务与会话是两条独立事实流（级联删除会抹掉现场事实）
  AND (SELECT count(*) FROM pg_constraint
        WHERE conrelid = '__EWOH_SCHEMA__.ewoh_exo_session'::regclass
          AND contype = 'f') = 0
  -- 租户隔离不变量未被本次改动破坏：RLS 仍启用、策略仍在
  AND (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_exo_session'::regclass) = true
  AND (SELECT count(*) FROM pg_policies
        WHERE schemaname = current_schema()
          AND tablename = 'ewoh_exo_session'
          AND policyname = 'exo_session_org_isolation') = 1
  THEN 1 ELSE 0 END AS standalone_079_verified;
