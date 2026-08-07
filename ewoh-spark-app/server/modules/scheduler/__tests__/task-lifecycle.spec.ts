import { TaskLifecycle } from '../task-lifecycle';

describe('TaskLifecycle（统一任务生命周期，Task 0.3）', () => {
  describe('isSchedulable', () => {
    it('可调度状态', () => {
      for (const s of ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch', 'pending', 'queued']) {
        expect(TaskLifecycle.isSchedulable(s)).toBe(true);
      }
    });
    it('不可调度状态', () => {
      for (const s of ['dispatched', 'received', 'executing', 'completed', 'cancelled', 'paused', 'exception']) {
        expect(TaskLifecycle.isSchedulable(s)).toBe(false);
      }
    });
  });

  describe('isLocked', () => {
    it('已锁定状态', () => {
      for (const s of ['dispatched', 'received', 'executing', 'paused', 'exception']) {
        expect(TaskLifecycle.isLocked(s)).toBe(true);
      }
    });
    it('未锁定状态', () => {
      for (const s of ['draft', 'pending_dispatch', 'completed', 'cancelled']) {
        expect(TaskLifecycle.isLocked(s)).toBe(false);
      }
    });
  });

  describe('isExecuting', () => {
    it('执行中状态', () => {
      for (const s of ['executing', 'received', 'paused']) {
        expect(TaskLifecycle.isExecuting(s)).toBe(true);
      }
    });
    it('非执行中状态', () => {
      for (const s of ['draft', 'dispatched', 'completed', 'cancelled']) {
        expect(TaskLifecycle.isExecuting(s)).toBe(false);
      }
    });
  });

  describe('isTerminal', () => {
    it('终态', () => {
      for (const s of ['completed', 'cancelled', 'done']) {
        expect(TaskLifecycle.isTerminal(s)).toBe(true);
      }
    });
    it('非终态', () => {
      for (const s of ['draft', 'pending_dispatch', 'executing', 'paused']) {
        expect(TaskLifecycle.isTerminal(s)).toBe(false);
      }
    });
  });

  describe('isDispatchable', () => {
    it('可下发状态', () => {
      for (const s of ['pending_dispatch', 'dispatched', 'received', 'executing']) {
        expect(TaskLifecycle.isDispatchable(s)).toBe(true);
      }
    });
    it('不可下发状态', () => {
      for (const s of ['draft', 'paused', 'exception', 'completed', 'cancelled']) {
        expect(TaskLifecycle.isDispatchable(s)).toBe(false);
      }
    });
  });
});