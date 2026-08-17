/**
 * 统一任务生命周期判定（Task 0.3）。
 * 基于 task.service.ts `nextTaskStatus` 的真实状态机：
 * draft → pending_confirm → pending_approval → pending_dispatch → dispatched → received → executing → paused / exception → completed / cancelled。
 * 同时兼容历史别名（pending / queued）以不破坏既有 seed 测试。
 */

/**
 * NESP-117（2026-08-17）：状态分类常量导出（单一事实源）——测试与消费方
 * 绑定本常量集合，不再各自硬编码字符串枚举（契约事实源：
 * contracts/state-machines/task.yaml）。
 */
export const TASK_SCHEDULABLE_STATUSES: readonly string[] = [
  'draft',
  'pending_confirm',
  'pending_approval',
  'pending_dispatch',
  // 历史别名（兼容既有 seed 测试）
  'pending',
  'queued',
];

export const TASK_LOCKED_STATUSES: readonly string[] = [
  'dispatched',
  'received',
  'executing',
  'paused',
  'exception',
];

export const TASK_DISPATCHABLE_STATUSES: readonly string[] = [
  'pending_dispatch',
  'dispatched',
  'received',
  'executing',
];

export const TASK_EXECUTING_STATUSES: readonly string[] = [
  'executing',
  'received',
  'paused',
];

/** 终态（契约 task.yaml terminal）：completed/cancelled。 */
export const TASK_TERMINAL_STATUSES: readonly string[] = [
  'completed',
  'cancelled',
];

export const TaskLifecycle = {
  /**
   * 可调度：尚未派发执行、可进入排程的任务状态。
   */
  isSchedulable(status: string): boolean {
    return TASK_SCHEDULABLE_STATUSES.includes(status);
  },

  /**
   * 已锁定：已派发/执行中，不可再改派。
   */
  isLocked(status: string): boolean {
    return TASK_LOCKED_STATUSES.includes(status);
  },

  /**
   * 可下发：pending_dispatch 及其后续已派发/执行中状态（供 dispatch 预检使用）。
   */
  isDispatchable(status: string): boolean {
    return TASK_DISPATCHABLE_STATUSES.includes(status);
  },

  /**
   * 执行中：正在进行或处于可继续执行状态。
   */
  isExecuting(status: string): boolean {
    return TASK_EXECUTING_STATUSES.includes(status);
  },

  /**
   * 终态：已结束，不再参与任何调度。
   * NEST-168 修复（2026-08-17）：剔除非契约 'done'（contracts/state-machines/
   * task.yaml terminal=[completed, cancelled]，无 done 状态——历史拼写漂移）。
   */
  isTerminal(status: string): boolean {
    return TASK_TERMINAL_STATUSES.includes(status);
  },
};