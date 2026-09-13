-- EWOH 命令"已交付网关"时刻（NO-67b）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / 幂等可重复执行。
--
-- 背景（本轮实测踩到的口径缺陷）：单设备**投递配额**需要"最近 60s 真正投出去几条"，
-- 一开始复用了 `authorization_verified_at`。但那个字段在**下发**时也会写（下发前同样要
-- 过授权闸门）→ 刚下发的 4 条命令立刻把配额算成用尽，配额闸门把**还没投出去**的命令
-- 全判成超限（e2e 实测：delivered=0 / quotaDeferred=4 / usedInWindow=4）。
--
-- 两个事实必须分开（原则 6：状态要能区分）：
--   · `authorization_verified_at`：**授权复核通过**的时刻（下发前 / 投递前各写一次）；
--   · `delivered_at`：**平台把命令交给网关**的时刻（只有投递路径写，一次投递一次）。
-- 配额、审计与页面都按 `delivered_at` 计；"下发 ≠ 交付"这条区分对现场排障同样重要。
--
-- 回滚语义：DROP COLUMN（additive；历史行没有该事实 → NULL = 未交付过）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- 投递归属扫描（按设备 + 时间窗）走的部分索引：只覆盖已交付行。
CREATE INDEX IF NOT EXISTS idx_ewoh_control_command_delivered
  ON __EWOH_SCHEMA__.ewoh_control_command (org_id, delivered_at)
  WHERE delivered_at IS NOT NULL;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_control_command.delivered_at IS
  '平台把命令交给网关的时刻（NO-67b；投递路径唯一写入点）。NULL = 从未交付；与 authorization_verified_at（授权复核通过）是两个事实';
