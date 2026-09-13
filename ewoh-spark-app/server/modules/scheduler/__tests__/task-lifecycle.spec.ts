import {
  TaskLifecycle,
  TASK_SCHEDULABLE_STATUSES,
  TASK_LOCKED_STATUSES,
  TASK_DISPATCHABLE_STATUSES,
  TASK_EXECUTING_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_LEGACY_PRE_DISPATCH_STATUSES,
  TASK_PRE_DISPATCH_STATUS,
  isPreDispatchStatus,
  normalizePreDispatchStatus,
  requiresPreDispatchNormalization,
} from '../task-lifecycle';
import { taskActionPath } from '../../task/task.service';

/**
 * NESP-117（2026-08-17）：状态分类绑定导出常量集合（单一事实源，
 * contracts/state-machines/task.yaml）——不再各自硬编码字符串枚举；
 * 同时钉死契约事实：terminal = [completed, cancelled]，无 'done'（NEST-168）。
 */
describe('TaskLifecycle（统一任务生命周期，Task 0.3）', () => {
  describe('常量集合与契约对齐', () => {
    it('TASK_TERMINAL_STATUSES 严格等于契约 terminal（无 done）', () => {
      expect([...TASK_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed']);
    });
    it('各分类集合互不重叠终态/可调度', () => {
      for (const s of TASK_SCHEDULABLE_STATUSES) {
        expect(TASK_TERMINAL_STATUSES).not.toContain(s);
      }
    });
  });

  describe('isSchedulable', () => {
    it('可调度状态（绑定常量）', () => {
      for (const s of TASK_SCHEDULABLE_STATUSES) {
        expect(TaskLifecycle.isSchedulable(s)).toBe(true);
      }
    });
    it('不可调度状态（绑定锁定+终态常量）', () => {
      for (const s of [...TASK_LOCKED_STATUSES, ...TASK_TERMINAL_STATUSES]) {
        expect(TaskLifecycle.isSchedulable(s)).toBe(false);
      }
    });
  });

  describe('isLocked', () => {
    it('已锁定状态（绑定常量）', () => {
      for (const s of TASK_LOCKED_STATUSES) {
        expect(TaskLifecycle.isLocked(s)).toBe(true);
      }
    });
    it('未锁定状态', () => {
      for (const s of ['draft', 'pending_dispatch', ...TASK_TERMINAL_STATUSES]) {
        expect(TaskLifecycle.isLocked(s)).toBe(false);
      }
    });
  });

  describe('isExecuting', () => {
    it('执行中状态（绑定常量）', () => {
      for (const s of TASK_EXECUTING_STATUSES) {
        expect(TaskLifecycle.isExecuting(s)).toBe(true);
      }
    });
    it('非执行中状态', () => {
      for (const s of ['draft', 'dispatched', ...TASK_TERMINAL_STATUSES]) {
        expect(TaskLifecycle.isExecuting(s)).toBe(false);
      }
    });
  });

  describe('isTerminal', () => {
    it('终态（绑定常量：completed/cancelled）', () => {
      for (const s of TASK_TERMINAL_STATUSES) {
        expect(TaskLifecycle.isTerminal(s)).toBe(true);
      }
    });
    it('非终态', () => {
      for (const s of ['draft', 'pending_dispatch', 'executing', 'paused']) {
        expect(TaskLifecycle.isTerminal(s)).toBe(false);
      }
    });
    it('NEST-168：非契约状态 done 不是终态（task.yaml 无此状态）', () => {
      expect(TaskLifecycle.isTerminal('done')).toBe(false);
    });
  });

  describe('isDispatchable', () => {
    it('可下发状态（绑定常量）', () => {
      for (const s of TASK_DISPATCHABLE_STATUSES) {
        expect(TaskLifecycle.isDispatchable(s)).toBe(true);
      }
    });
    it('不可下发状态', () => {
      for (const s of ['draft', 'paused', 'exception', ...TASK_TERMINAL_STATUSES]) {
        expect(TaskLifecycle.isDispatchable(s)).toBe(false);
      }
    });
  });

  /**
   * 2026-09-10 缺陷回归：可调度与可下发必须对历史别名给出**一致**判定。
   *
   * 旧行为：isSchedulable('pending') === true 而 isDispatchable('pending') === false。
   * 于是存量为 pending/queued 的任务能被排程、能被审批，dispatch 却抛
   * PLAN_TASK_NOT_DISPATCHABLE —— 方案停在 approved、任务卡死，用户看不到
   * 任何解释。这个不一致就是"死路"的成因。
   */
  describe('历史别名一致性（半程迁移回归）', () => {
    it('每个可调度状态都能经状态机到达 dispatched（无死路）', () => {
      // 这才是真正的性质：可调度的任务不该在派发处变成死路。
      // 旧行为下 'pending'/'queued' 被排程、被审批，但 dispatch 预检直接拒绝，
      // 用户拿到一个既不能完成也不能解释的 approved 方案。
      for (const s of TASK_SCHEDULABLE_STATUSES) {
        if (TaskLifecycle.isDispatchable(s)) continue;
        // 不可直接下发时，必须存在经契约状态机到达 dispatched 的合法动作链。
        const path = taskActionPath(s, 'dispatched');
        expect({ status: s, path }).toEqual({ status: s, path: expect.any(Array) });
        expect(path!.length).toBeGreaterThan(0);
      }
    });

    it('契约外别名 pending/queued 可下发（否则存量任务永久卡死）', () => {
      for (const legacy of TASK_LEGACY_PRE_DISPATCH_STATUSES) {
        expect(TaskLifecycle.isSchedulable(legacy)).toBe(true);
        expect(TaskLifecycle.isDispatchable(legacy)).toBe(true);
      }
    });

    it('别名不是契约状态：schedulable 集合里它们被显式标注为 legacy', () => {
      // 契约内可调度状态 + 别名 = 完整集合（防止有人把别名当契约状态继续扩散）
      const contractStatuses = ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch'];
      expect([...TASK_SCHEDULABLE_STATUSES].sort())
        .toEqual([...contractStatuses, ...TASK_LEGACY_PRE_DISPATCH_STATUSES].sort());
    });

    it('normalizePreDispatchStatus 把别名收敛到契约状态，契约状态原样返回', () => {
      for (const legacy of TASK_LEGACY_PRE_DISPATCH_STATUSES) {
        expect(normalizePreDispatchStatus(legacy)).toBe(TASK_PRE_DISPATCH_STATUS);
        expect(requiresPreDispatchNormalization(legacy)).toBe(true);
      }
      for (const contract of ['draft', 'pending_confirm', 'pending_approval', TASK_PRE_DISPATCH_STATUS,
        'dispatched', 'received', 'executing', 'paused', 'exception',
        ...TASK_TERMINAL_STATUSES]) {
        expect(normalizePreDispatchStatus(contract)).toBe(contract);
        expect(requiresPreDispatchNormalization(contract)).toBe(false);
      }
    });

    it('isPreDispatch：契约派发前状态与别名均为 true，派发后/锁定态为 false', () => {
      expect(isPreDispatchStatus(TASK_PRE_DISPATCH_STATUS)).toBe(true);
      for (const legacy of TASK_LEGACY_PRE_DISPATCH_STATUSES) {
        expect(isPreDispatchStatus(legacy)).toBe(true);
      }
      for (const s of ['dispatched', 'received', 'executing', 'paused', 'exception', 'completed', 'cancelled']) {
        expect(isPreDispatchStatus(s)).toBe(false);
      }
    });

    it('归一化不会放宽锁定态/终态（防止被误用为"万能转换"）', () => {
      for (const s of [...TASK_LOCKED_STATUSES, ...TASK_TERMINAL_STATUSES]) {
        expect(normalizePreDispatchStatus(s)).toBe(s);
        expect(TaskLifecycle.isDispatchable(s)).toBe(TASK_DISPATCHABLE_STATUSES.includes(s));
      }
    });
  });
});
