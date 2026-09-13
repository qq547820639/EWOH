-- 084 rollback：移除责任人班次维度。
--
-- 回滚前先把"非全天"的 active 行停用（否则恢复旧唯一索引会被"同职责多班次"撞车）。
-- 停用 = 保留事实（不是删除），恢复旧语义后现场仍能看到历史。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

UPDATE __EWOH_SCHEMA__.ewoh_device_responsibility
   SET active = false,
       deactivated_at = COALESCE(deactivated_at, now()),
       deactivated_by = COALESCE(deactivated_by, 'rollback:084'),
       _updated_at = now()
 WHERE active AND shift_id <> '';

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_device_responsibility_shift;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_device_responsibility_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_device_responsibility_active
  ON __EWOH_SCHEMA__.ewoh_device_responsibility (org_id, device_id, responsibility)
  WHERE active;

ALTER TABLE __EWOH_SCHEMA__.ewoh_device_responsibility DROP COLUMN IF EXISTS shift_id;
