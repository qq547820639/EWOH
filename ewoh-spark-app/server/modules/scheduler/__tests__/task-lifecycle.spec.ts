import {
  TaskLifecycle,
  TASK_SCHEDULABLE_STATUSES,
  TASK_LOCKED_STATUSES,
  TASK_DISPATCHABLE_STATUSES,
  TASK_EXECUTING_STATUSES,
  TASK_TERMINAL_STATUSES,
} from '../task-lifecycle';

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
});
