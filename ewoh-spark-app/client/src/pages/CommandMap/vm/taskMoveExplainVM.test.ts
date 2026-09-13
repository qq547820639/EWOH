/* Task 5 / P1：taskMoveExplainVM 功能测试（old→new + 服务端顺序原因链 + 未变化任务）。 */
import { taskMoveExplainVM, taskMoveReasonLabel } from './taskMoveExplainVM';
import type { DecisionTrace, PlanAssignmentDiff, ReplanImpact } from '@shared/api.interface';

function makeDiff(overrides: Partial<PlanAssignmentDiff> = {}): PlanAssignmentDiff {
  return {
    taskId: 'T381',
    changeTypes: ['PERSON_CHANGED', 'DEVICE_CHANGED'],
    before: {
      taskId: 'T381',
      personId: 'P-John',
      deviceId: 'EXO-17',
      stationId: 'S4',
      plannedStart: '2026-08-10T08:00:00.000Z',
      plannedEnd: '2026-08-10T09:00:00.000Z',
    },
    after: {
      taskId: 'T381',
      personId: 'P-Li',
      deviceId: 'EXO-12',
      stationId: 'S4',
      plannedStart: '2026-08-10T08:00:00.000Z',
      plannedEnd: '2026-08-10T09:00:00.000Z',
    },
    reasons: ['DEVICE_OFFLINE:D-1'],
    ...overrides,
  };
}

function makeImpact(): ReplanImpact {
  return {
    triggerType: 'DEVICE_OFFLINE',
    triggerIds: ['D-1'],
    affectedTaskIds: ['T381'],
    affectedResourceIds: ['D-1'],
    affectedPersonIds: [],
    affectedDeviceIds: ['D-1'],
    affectedStationIds: [],
    affectedZoneIds: [],
    frozenAssignmentIds: [],
    movableAssignmentIds: ['T381'],
    reasons: ['DEVICE_OFFLINE:D-1', 'ROUTE_BLOCKED:R-7'],
    snapshotVersion: 'WS-9',
    baselinePlanVersion: 1,
  };
}

function makeTrace(): DecisionTrace {
  return {
    taskId: 'T381',
    selected: { personId: 'P-Li', deviceId: 'EXO-12', stationId: 'S4' },
    priority: { level: 'high', score: 42, factors: [] },
    candidates: [],
    selectedReason: ['负荷均衡：选中 P-Li'],
    rejectedAlternatives: [],
    policyVersion: 7,
    solverVersion: 'cp-sat-v3',
    snapshotVersion: 'WS-9',
  };
}

describe("taskMoveExplainVM：'Why did this task move?' 原因链", () => {
  it('无 diff → null（不伪造移动事实）', () => {
    expect(taskMoveExplainVM({ diff: null, impact: makeImpact(), trace: makeTrace() })).toBeNull();
  });

  it('渲染 old→new 分配（person/device/station）', () => {
    const vm = taskMoveExplainVM({ diff: makeDiff(), impact: makeImpact(), trace: makeTrace() })!;
    expect(vm.taskId).toBe('T381');
    expect(vm.old).toEqual({ personId: 'P-John', deviceId: 'EXO-17', stationId: 'S4', plannedStart: '2026-08-10T08:00:00.000Z', plannedEnd: '2026-08-10T09:00:00.000Z' });
    expect(vm.current).toEqual({ personId: 'P-Li', deviceId: 'EXO-12', stationId: 'S4', plannedStart: '2026-08-10T08:00:00.000Z', plannedEnd: '2026-08-10T09:00:00.000Z' });
    expect(vm.changed).toEqual({ person: true, device: true, station: false });
  });

  it('原因链按服务端顺序拼接并去重（trigger → diff → trace），不发明因果', () => {
    const vm = taskMoveExplainVM({ diff: makeDiff(), impact: makeImpact(), trace: makeTrace() })!;
    // impact.reasons=['DEVICE_OFFLINE:D-1','ROUTE_BLOCKED:R-7']，diff.reasons=['DEVICE_OFFLINE:D-1']（去重），trace.selectedReason=['负荷均衡：选中 P-Li']
    expect(vm.causeChain.map((c) => c.code)).toEqual([
      'DEVICE_OFFLINE:D-1',
      'ROUTE_BLOCKED:R-7',
      '负荷均衡：选中 P-Li',
    ]);
    expect(vm.causeChain.map((c) => c.label)).toEqual(['设备离线（D-1）', '路线阻断（R-7）', '负荷均衡：选中 P-Li']);
    expect(vm.causeChain.map((c) => c.origin)).toEqual(['trigger', 'trigger', 'trace']);
  });

  it('触发类型直映服务端 ReplanImpact.triggerType', () => {
    const vm = taskMoveExplainVM({ diff: makeDiff(), impact: makeImpact(), trace: makeTrace() })!;
    expect(vm.triggerType).toBe('DEVICE_OFFLINE');
  });

  it('未变化/变更任务计数透传（调用方由权威 diff 派生）', () => {
    const vm = taskMoveExplainVM({
      diff: makeDiff(),
      impact: makeImpact(),
      trace: makeTrace(),
      unchangedTaskCount: 23,
      changedTaskCount: 4,
      unchangedTaskIds: ['T400', 'T401'],
    })!;
    expect(vm.unchangedTaskCount).toBe(23);
    expect(vm.changedTaskCount).toBe(4);
    expect(vm.unchangedTaskIds).toEqual(['T400', 'T401']);
  });

  it('只有 flat 原因时按服务端顺序渲染为链', () => {
    const diff = makeDiff({ reasons: ['ROUTE_BLOCKED:R-7'] });
    const vm = taskMoveExplainVM({ diff, impact: null, trace: null })!;
    expect(vm.causeChain.map((c) => c.label)).toEqual(['路线阻断（R-7）']);
  });
});

describe('taskMoveReasonLabel：原因码 → 展示文案（纯映射）', () => {
  it('触发码与带实体后缀的触发码均映射', () => {
    expect(taskMoveReasonLabel('DEVICE_OFFLINE')).toBe('设备离线');
    // 实体后缀不再被丢弃：现场需要知道是哪台设备
    expect(taskMoveReasonLabel('DEVICE_OFFLINE:D-1')).toBe('设备离线（D-1）');
    expect(taskMoveReasonLabel('ROUTE_BLOCKED:R-7')).toBe('路线阻断（R-7）');
  });

  it('回退到 decisionReasonLabel 的约束/拒绝码表', () => {
    expect(taskMoveReasonLabel('missing_skill')).toBe('缺少技能');
    expect(taskMoveReasonLabel('MAX_WORKLOAD')).toBe('负荷超限');
  });

  it('未知码显式标注未登记（不伪造文案，保留原码可排查）', () => {
    expect(taskMoveReasonLabel('SOME_UNKNOWN_CODE')).toBe('未登记原因（SOME_UNKNOWN_CODE）');
  });

  it('带实体后缀的触发码保留实体信息（DEVICE_OFFLINE:D-1）', () => {
    expect(taskMoveReasonLabel('DEVICE_OFFLINE:D-1')).toBe('设备离线（D-1）');
  });
});
