-- 079 rollback：移除会话↔任务关联。
--
-- 只丢弃"关联"这一层信息：会话本身（谁、哪台设备、何时开始/结束）完整保留。
-- 这是有意的——回滚一个**关联**不应抹掉物理发生过的现场事实；
-- 代价是回滚后按任务回查会话的能力消失（需要时重新 apply 并补录关联）。

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_exo_session_task;
ALTER TABLE __EWOH_SCHEMA__.ewoh_exo_session DROP COLUMN IF EXISTS task_id;
