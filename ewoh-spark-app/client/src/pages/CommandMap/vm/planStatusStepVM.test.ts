// planStatusStepVM.test.ts — 方案状态流转指示纯函数测试。
import { planStatusSteps, PLAN_STATUS_LABELS } from './planStatusStepVM';

describe('planStatusSteps', () => {
  it('shadow → 第一步 current，其余 todo', () => {
    const steps = planStatusSteps('shadow');
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ['shadow', 'current'],
      ['approved', 'todo'],
      ['dispatched', 'todo'],
      ['executing', 'todo'],
    ]);
  });

  it('approved → shadow done，approved current', () => {
    const steps = planStatusSteps('approved');
    expect(steps.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo']);
  });

  it('dispatched / executing 依次推进', () => {
    expect(planStatusSteps('dispatched').map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo']);
    expect(planStatusSteps('executing').map((s) => s.state)).toEqual(['done', 'done', 'done', 'current']);
  });

  it('completed → 全链 done；draft/rejected/superseded → 全链 todo', () => {
    expect(planStatusSteps('completed').map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    for (const status of ['draft', 'rejected', 'superseded'] as const) {
      expect(planStatusSteps(status).map((s) => s.state)).toEqual(['todo', 'todo', 'todo', 'todo']);
    }
  });

  it('8 个状态均有中文标签', () => {
    const statuses = [
      'draft',
      'shadow',
      'approved',
      'dispatched',
      'executing',
      'completed',
      'rejected',
      'superseded',
    ] as const;
    for (const status of statuses) {
      expect(PLAN_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
