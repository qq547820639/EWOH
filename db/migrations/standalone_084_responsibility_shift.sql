-- 084: 设备责任人增加"班次维度"（ewoh_device_responsibility.shift_id）
--
-- 背景（NO-51a，2026-09-12）：
--
-- 上一轮（NO-49a/NO-50a）把"这台设备谁负责"落成了事实，但它只有 (设备, 职责, 人) 三元组——
-- 现实里同一台设备**不同班次由不同人负责**（A 班张三、B 班李四）。缺这一维时现场只能
-- "谁当班就把责任人改成谁"，结果：①另一班的责任人事实被覆盖（只剩历史行）；
-- ②夜班提醒常常发给**已经下班的人**。
--
-- 本迁移只加一列 + 重建唯一索引（不改既有语义）：
--   · `shift_id`：**空串 = 全天/不限班次**（不是 NULL——NULL 在唯一索引里互不相等，
--     会让"同一职责同一班次只能有一位"的约束失效；实测教训：NULL 语义在部分索引里会踩坑）；
--   · 唯一索引从 (org, device, responsibility) 改为
--     (org, device, responsibility, shift_id)：**同一职责的同一班次只能有一位**，
--     但"全天责任人 + 各班的班次责任人"可以并存（查找时本班优先、全天兜底）。
--
-- 回滚语义：回滚 = 删列 + 恢复旧唯一索引；此时"同职责多班次"的存量行会撞旧唯一索引，
-- 因此 rollback 脚本会先把**非全天行**保留为停用（不删事实）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_device_responsibility
  ADD COLUMN IF NOT EXISTS shift_id varchar(255) NOT NULL DEFAULT '';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device_responsibility.shift_id IS
  '责任关系适用的班次（ewoh_shift.shift_id）；空串 = 全天/不限班次（不是 NULL：NULL 在唯一索引里互不相等，会破坏"同职责同班次唯一"的约束）。';

-- 旧唯一索引（不含班次）→ 新唯一索引（含班次）
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_device_responsibility_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_device_responsibility_active
  ON __EWOH_SCHEMA__.ewoh_device_responsibility (org_id, device_id, responsibility, shift_id)
  WHERE active;

-- 按班次查"本班责任人"是提醒路由的热路径
CREATE INDEX IF NOT EXISTS idx_ewoh_device_responsibility_shift
  ON __EWOH_SCHEMA__.ewoh_device_responsibility (org_id, device_id, shift_id)
  WHERE active;
