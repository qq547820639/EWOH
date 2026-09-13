-- EWOH 方案取消/回滚列 (standalone_077, DR-5 审批-拒绝-部分执行-回滚补全)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（目标三"审批、拒绝、部分执行和回滚"）：dispatched/executing 方案此前
-- 无取消路径（WaveDispatchPanel 明示"当前没有取消派工的接口"）。回滚语义：
--   - 未开始的 assignment（proposed/approved/dispatched/acknowledged 且任务
--     未被接收）→ cancelled + 释放预占 + 任务回退 pending_dispatch；
--   - 已开始的（received/executing/completed/failed）保持原状并如实回报
--     "不可回滚"清单（物理执行不可撤销，只能现场处置）。
-- 方案状态机新增终态 cancelled（shared/scheduler.ts PlanStatus 同步）。
-- 取消事实（谁/何时/为何）落列 + 审计 + outbox 事件 PlanCancelled。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS cancelled_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by varchar(255),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.cancelled_reason IS '取消/回滚原因（必填，人可读；写入路径 PlanService.cancelPlan）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.cancelled_by IS '取消操作者（服务端会话 actor.userId）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.cancelled_at IS '取消时间';
