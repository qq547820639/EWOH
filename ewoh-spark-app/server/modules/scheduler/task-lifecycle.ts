/**
 * 统一任务生命周期判定（Task 0.3）。
 * 基于 task.service.ts `nextTaskStatus` 的真实状态机：
 * draft → pending_confirm → pending_approval → pending_dispatch → dispatched → received → executing → paused / exception → completed / cancelled。
 * 同时兼容历史别名（pending / queued / done）以不破坏既有 seed 测试。
 */
export const TaskLifecycle = {
  /**
   * 可调度：尚未派发执行、可进入排程的任务状态。
   */
  isSchedulable(status: string): boolean {
    return [
      'draft',
      'pending_confirm',
      'pending_approval',
      'pending_dispatch',
      // 历史别名（兼容既有 seed 测试）
      'pending',
      'queued',
    ].includes(status);
  },

  /**
   * 已锁定：已派发/执行中，不可再改派。
   */
  isLocked(status: string): boolean {
    return [
      'dispatched',
      'received',
      'executing',
      'paused',
      'exception',
    ].includes(status);
  },

  /**
   * 可下发：pending_dispatch 及其后续已派发/执行中状态（供 dispatch 预检使用）。
   */
  isDispatchable(status: string): boolean {
    return [
      'pending_dispatch',
      'dispatched',
      'received',
      'executing',
    ].includes(status);
  },

  /**
   * 执行中：正在进行或处于可继续执行状态。
   */
  isExecuting(status: string): boolean {
    return ['executing', 'received', 'paused'].includes(status);
  },

  /**
   * 终态：已结束，不再参与任何调度。
   */
  isTerminal(status: string): boolean {
    return ['completed', 'cancelled', 'done'].includes(status);
  },
};