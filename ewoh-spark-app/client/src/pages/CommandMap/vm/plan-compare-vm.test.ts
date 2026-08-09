/* Phase 4 / P4-COMPARE：planCompareMapVM 纯函数测试。
 *
 * 覆盖：三模式装配、changeTypes 透传（不重判）、before/after 坐标、缺失坐标、
 * 未变化任务提取、churn/计数。
 */
import { planCompareMapVM, extractUnchangedTasks } from './planCompareVM';
import type { PlanCompareResult, PlanAssignmentDiff } from '@shared/api.interface';

function diff(taskId: string, changeTypes: PlanAssignmentDiff['changeTypes']): PlanAssignmentDiff {
  return {
    taskId,
    changeTypes,
    reasons: [`reason-${taskId}`],
    before: {
      taskId,
      personId: 'P1',
      deviceId: null,
      stationId: 'ST-1',
      plannedStart: '2026-08-09T10:00:00Z',
      etaSeconds: 120,
      distanceMeters: 300,
    },
    after: {
      taskId,
      personId: 'P2',
      deviceId: null,
      stationId: 'ST-2',
      plannedStart: '2026-08-09T10:05:00Z',
      etaSeconds: 180,
      distanceMeters: 450,
    },
  };
}

const result: PlanCompareResult = {
  baselinePlanId: 'PLAN-A',
  candidatePlanId: 'PLAN-B',
  added: ['T-ADD'],
  removed: ['T-RMV'],
  diffByTask: [
    diff('T-1', ['PERSON_CHANGED', 'STATION_CHANGED']),
    diff('T-2', ['TIME_CHANGED']),
  ],
  changeTypeCounts: { PERSON_CHANGED: 1, STATION_CHANGED: 1, TIME_CHANGED: 1 },
  churn: 3,
  aggregate: {},
};

const snapshot = {
  persons: [{ id: 'P1', x: 10, y: 10 }],
  stations: [
    { id: 'ST-1', x: 100, y: 100 },
    { id: 'ST-2', x: 200, y: 200 },
  ],
};

describe('planCompareMapVM', () => {
  it('DIFF 模式：透传后端 changeTypes，不重新判断', () => {
    const vm = planCompareMapVM(result, 'DIFF', snapshot);
    expect(vm.mode).toBe('DIFF');
    expect(vm.entries).toHaveLength(2);
    expect(vm.entries[0].changeTypes).toEqual(['PERSON_CHANGED', 'STATION_CHANGED']);
    expect(vm.entries[0].reasons).toEqual(['reason-T-1']);
    expect(vm.entries[0].before?.point).toEqual({ x: 100, y: 100 });
    expect(vm.entries[0].after?.point).toEqual({ x: 200, y: 200 });
  });

  it('DIFF 模式：before/after 坐标缺失时标记 missingCoordinates（不伪造位置）', () => {
    const noStation: PlanCompareResult = {
      ...result,
      diffByTask: [
        {
          taskId: 'T-X',
          changeTypes: ['STATION_CHANGED'],
          reasons: [],
          before: { taskId: 'T-X', personId: null, deviceId: null, stationId: 'GHOST-1', plannedStart: null },
          after: { taskId: 'T-X', personId: null, deviceId: null, stationId: 'GHOST-2', plannedStart: null },
        },
      ],
    };
    const vm = planCompareMapVM(noStation, 'DIFF', snapshot);
    expect(vm.entries[0].before?.point).toBeNull();
    expect(vm.entries[0].after?.point).toBeNull();
    expect(vm.missingCoordinates).toContain('T-X');
  });

  it('BASELINE 模式：只用 before 侧', () => {
    const vm = planCompareMapVM(result, 'BASELINE', snapshot);
    expect(vm.mode).toBe('BASELINE');
    // 展示模型仍然带 before/after（地图层按模式取侧），坐标均可用。
    expect(vm.entries[0].before?.point).toEqual({ x: 100, y: 100 });
  });

  it('CANDIDATE 模式：只用 after 侧', () => {
    const vm = planCompareMapVM(result, 'CANDIDATE', snapshot);
    expect(vm.entries[0].after?.point).toEqual({ x: 200, y: 200 });
  });

  it('added/removed/churn/changeTypeCounts 透传后端值', () => {
    const vm = planCompareMapVM(result, 'DIFF', snapshot);
    expect(vm.addedCount).toBe(1);
    expect(vm.removedCount).toBe(1);
    expect(vm.changedCount).toBe(2);
    expect(vm.churn).toBe(3);
    expect(vm.changeTypeCounts).toEqual({ PERSON_CHANGED: 1, STATION_CHANGED: 1, TIME_CHANGED: 1 });
  });
});

describe('extractUnchangedTasks', () => {
  it('candidate 中未触及的 assignment 作为未变化上下文', () => {
    const cand = [
      { taskId: 'T-1' },
      { taskId: 'T-2' },
      { taskId: 'T-3' },
      { taskId: 'T-4' },
    ];
    const unchanged = extractUnchangedTasks(result, cand);
    expect(unchanged).toEqual(['T-3', 'T-4']);
  });

  it('added/removed 也算触及（不进入未变化）', () => {
    const cand = [{ taskId: 'T-ADD' }, { taskId: 'T-KEEP' }];
    expect(extractUnchangedTasks(result, cand)).toEqual(['T-KEEP']);
  });
});
