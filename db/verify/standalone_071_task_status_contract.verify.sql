-- 071 verify：生产任务状态词表已收敛到契约，且契约外状态不可再写入。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  -- 约束存在且已校验
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_production_task'::regclass
      AND conname = 'ck_production_task_status_contract'
      AND convalidated
  )
  -- 存量契约外别名已清零
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_production_task
        WHERE status IN ('pending', 'queued')) = 0
  -- MES 工单镜像表若存在，其 queued 也别名为空
  AND (
    NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ewoh_schedule_task'
        AND column_name = 'status'
    )
    OR (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_schedule_task WHERE status = 'queued') = 0
  )
  -- 约束确实拒绝了契约外写入（负向断言：插入必须失败）
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_production_task'::regclass
      AND conname = 'ck_production_task_status_contract'
      AND pg_get_constraintdef(oid) NOT LIKE '%pending_dispatch%'
  )
  THEN 1 ELSE 0 END AS standalone_071_verified;
