/* commandMapSelector.test.ts — 图层开关 + 执行记录聚合透出（R-6 / ADR-035，node 可测）。 */
import {
  buildCommandMapState,
  toggleLayer,
  DEFAULT_UI_STATE,
  type CommandMapLayer,
} from './commandMapSelector';
import type { SchedulingExecution } from '@shared/scheduler';

function exec(executionId: string): SchedulingExecution {
  return {
    id: executionId,
    executionId,
    orgId: null,
    runId: null,
    planId: 'PLAN-1',
    assignmentId: `ASGN-${executionId}`,
    taskId: 'TASK-1',
    personId: 'P-1',
    deviceId: null,
    stationId: null,
    plannedStartAt: null,
    plannedEndAt: null,
    actualStartAt: null,
    actualEndAt: null,
    plannedTravelMs: null,
    actualTravelMs: null,
    plannedDistanceM: null,
    actualDistanceM: null,
    plannedWaitingMs: null,
    actualWaitingMs: null,
    status: 'STARTED',
    deviationType: null,
    deviationReason: null,
    snapshotVersion: null,
    policyVersion: null,
    solverVersion: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
}

describe('toggleLayer（图层开关纯函数）', () => {
  it('关闭图层 → 开启；再点 → 关闭（幂等，无重复）', () => {
    let next: CommandMapLayer[] = [];
    next = toggleLayer(next, 'conflict');
    expect(next).toEqual(['conflict']);
    next = toggleLayer(next, 'conflict');
    expect(next).toEqual([]);
    next = toggleLayer(next, 'execution-deviation');
    expect(next).toEqual(['execution-deviation']);
    next = toggleLayer(next, 'conflict');
    expect(next).toEqual(['execution-deviation', 'conflict']);
    next = toggleLayer(next, 'execution-deviation');
    expect(next).toEqual(['conflict']);
  });

  it('base 不可开关（恒为底层）', () => {
    expect(toggleLayer(['conflict'], 'base')).toEqual(['conflict']);
  });

  it('不修改原数组（不可变更新）', () => {
    const prev: CommandMapLayer[] = ['conflict'];
    const next = toggleLayer(prev, 'risk');
    expect(prev).toEqual(['conflict']);
    expect(next).not.toBe(prev);
  });
});

describe('buildCommandMapState（R-6：执行记录透出）', () => {
  it('executions 透传（数组引用透传，不重算）', () => {
    const executions = [exec('E-1'), exec('E-2')];
    const state = buildCommandMapState({
      snapshot: null,
      resources: [],
      plans: [],
      routes: null,
      conflicts: [],
      executions,
      ui: DEFAULT_UI_STATE,
      loading: false,
      hasError: false,
    });
    expect(state.executions).toEqual(executions);
    expect(state.executionsError).toBe(false);
  });

  it('executions 未提供 → 显式空数组（不静默 null）', () => {
    const state = buildCommandMapState({
      snapshot: null,
      resources: [],
      plans: [],
      routes: null,
      conflicts: [],
      ui: DEFAULT_UI_STATE,
      loading: false,
      hasError: false,
    });
    expect(state.executions).toEqual([]);
    expect(state.executionsError).toBe(false);
  });

  it('executionsError 标记透出（查询失败显式可见）', () => {
    const state = buildCommandMapState({
      snapshot: null,
      resources: [],
      plans: [],
      routes: null,
      conflicts: [],
      executions: null,
      executionsError: true,
      ui: DEFAULT_UI_STATE,
      loading: false,
      hasError: false,
    });
    expect(state.executions).toEqual([]);
    expect(state.executionsError).toBe(true);
  });
});
