-- 079: 会话 ↔ 任务关联（ewoh_exo_session.task_id）
--
-- 背景（NO-40a，2026-09-11 偏差复盘实测）：
--
-- 1) 会话记的是"谁戴了哪台设备"，**没记在干哪张任务**。于是"任务 ↔ 会话"只能靠
--    设备+人员间接推断，现场与调度都答不出"这次佩戴是在做哪张单"。
-- 2) 更直接的产品后果：偏差复盘的**可比样本率极低**——实测 90 条已收工会话里
--    只有 23 条同时记录了"预计结束 + 实际结束"，其余不可比。原因不是现场不愿意填，
--    而是**没人知道该填什么**：任务的计划结束时间（`ewoh_production_task.plan_end`）
--    本来就在库里，只是会话没有与任务建立关联，无法自动继承。
--
-- 修法：给会话一条显式、可空的 `task_id` 引用（同一租户内的业务任务 id）。
--   · 可空：临时试用/演示会话可以不属于任何任务（NULL 表示"未关联"，不是"没有任务"）；
--   · 不做外键约束：任务与会话是两条独立事实流（任务可被取消/回退，会话是物理发生过的
--     事实），级联删除会抹掉现场事实——用 (org_id, task_id) 索引支持按任务回查；
--   · 归属仍由 org_id 承担（RLS 策略不变）。
--
-- 预计结束时间的**来源**（继承任务计划 / 现场填写 / 未记录）写在 `record_json` 里
-- （`expectedEndSource`），不新增列：它是同一事实的溯源信息，随会话审计记录一起保存。

ALTER TABLE __EWOH_SCHEMA__.ewoh_exo_session
  ADD COLUMN IF NOT EXISTS task_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_session.task_id IS
  '关联的业务任务 id（ewoh_production_task.id，同租户）。NULL = 未关联任何任务（不是"没有任务"）。';

CREATE INDEX IF NOT EXISTS idx_ewoh_exo_session_task
  ON __EWOH_SCHEMA__.ewoh_exo_session (org_id, task_id);
