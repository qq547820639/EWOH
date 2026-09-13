/**
 * 统一任务生命周期判定（Task 0.3）。
 * 基于 task.service.ts `nextTaskStatus` 的真实状态机：
 * draft → pending_confirm → pending_approval → pending_dispatch → dispatched → received → executing → paused / exception → completed / cancelled。
 *
 * 历史别名（pending / queued）**不在** contracts/state-machines/task.yaml 里。
 * 它们只作为"迁移期存量数据"被识别，不再由任何写路径产生；见
 * `TASK_LEGACY_PRE_DISPATCH_STATUSES` 与 `normalizePreDispatchStatus`。
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
  // 历史别名：仅用于识别存量数据（见文件头说明），不再写入。
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

/**
 * 契约内"已就绪、等待派发"状态。
 *
 * 2026-09-10 缺陷修复：此前 `TASK_SCHEDULABLE_STATUSES` 接受历史别名
 * `pending`/`queued`，但 `TASK_DISPATCHABLE_STATUSES` 不接受——于是存量为
 * 这两个状态的任务**可以被排程、被审批，却永远无法派发**（dispatch 抛
 * `PLAN_TASK_NOT_DISPATCHABLE`）。半程迁移把用户带进死路：方案 approved，
 * 任务卡死，且没有任何提示说明原因。现在两处判定一致，且存量状态在派发时
 * 被显式归一化到契约状态（`normalizePreDispatchStatus`），使 plan 与 task
 * 状态不会长期分叉。
 */
export const TASK_PRE_DISPATCH_STATUS = 'pending_dispatch';

/** 契约外历史别名（迁移期存量数据专用，非可写入状态）。 */
export const TASK_LEGACY_PRE_DISPATCH_STATUSES: readonly string[] = [
  'pending',
  'queued',
];

export const TASK_DISPATCHABLE_STATUSES: readonly string[] = [
  TASK_PRE_DISPATCH_STATUS,
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

/**
 * 是否为"派发前"状态（契约状态或契约外历史别名）。
 * 派发流程据此决定是否推进状态机。
 */
export function isPreDispatchStatus(status: string): boolean {
  return status === TASK_PRE_DISPATCH_STATUS
    || TASK_LEGACY_PRE_DISPATCH_STATUSES.includes(status);
}

/**
 * 是否为需要归一化的契约外历史状态（`pending`/`queued`）。
 * 归一化只在迁移期需要，调用方应记录可观测日志。
 */
export function requiresPreDispatchNormalization(status: string): boolean {
  return TASK_LEGACY_PRE_DISPATCH_STATUSES.includes(status);
}

/**
 * 把契约外历史状态映射到契约状态；契约内状态原样返回。
 * 仅供状态机推进前的存量数据收敛使用，不得用于放宽终态/锁定态校验。
 */
export function normalizePreDispatchStatus(status: string): string {
  return requiresPreDispatchNormalization(status) ? TASK_PRE_DISPATCH_STATUS : status;
}

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
   * 可下发：契约内 pending_dispatch 及其后续已派发/执行中状态，外加迁移期
   * 历史别名（否则存量任务会被永久卡在 dispatch 之前）。
   */
  isDispatchable(status: string): boolean {
    return TASK_DISPATCHABLE_STATUSES.includes(status)
      || TASK_LEGACY_PRE_DISPATCH_STATUSES.includes(status);
  },

  /** 派发前状态（含历史别名）：派发后应推进到 dispatched。 */
  isPreDispatch(status: string): boolean {
    return isPreDispatchStatus(status);
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