-- 071 rollback：撤销状态词表收敛。
--
-- 约束与索引无条件移除（它们只是守卫，不承载数据语义）。
-- 数据归一化**不可逆**：pending/queued 与 pending_dispatch 在契约里本是
-- 同一语义位置，回滚时无法判断某行原本是哪个别名。因此这里不做反向
-- UPDATE——凭空猜测会把"迁移"变成"伪造历史"。需要旧词表的场景应显式
-- 重新 seed，而不是回滚数据。

ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  DROP CONSTRAINT IF EXISTS ck_production_task_status_contract;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_production_task_status_contract;
