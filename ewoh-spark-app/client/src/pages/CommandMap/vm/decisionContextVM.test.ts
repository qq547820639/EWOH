/* Task 5 / P1：decisionContextVM 功能测试（9 段映射，服务端字段直映，不重算）。 */
import { decisionContextVM, type DecisionContextInput } from './decisionContextVM';
import type {
  DecisionTrace,
  PlanAssignmentDiff,
  PlanCompareResult,
  ReplanImpact,
  SchedulingConflict,
  SchedulingPlanV2,
  TaskCandidatesResponse,
} from '@shared/api.interface';

function makePlan(overrides: Partial<SchedulingPlanV2> = {}): SchedulingPlanV2 {
  return {
    planId: 'PLAN-2',
    planName: '方案 B',
    version: 2,
    status: 'approved',
    trigger: { type: 'DEVICE_OFFLINE', entityId: 'D-1' },
    snapshotVersion: 'WS-9',
    policyVersion: 7,
    solverVersion: 'cp-sat-v3',
    solverStatus: 'OPTIMAL',
    horizonMinutes: 480,
    assignments: [
      {
        assignmentId: 'A-T381',
        taskId: 'T381',
        personId: 'P-Li',
        deviceId: 'EXO-12',
        stationId: 'S4',
        zoneId: null,
        plannedStart: '2026-08-10T08:00:00.000Z',
        plannedEnd: '2026-08-10T09:00:00.000Z',
        routeId: null,
        status: 'proposed',
        reasons: [],
        alternatives: [],
        decisionTrace: makeTrace(),
      },
    ],
    metrics: { lateMinutes: 12, walkingMeters: 310, stationWaitMinutes: 5, maxWorkload: 0.7, changeCost: 2 },
    baselineDelta: {},
    violations: [],
    createdAt: '2026-08-10T07:00:00.000Z',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    taskId: 'T381',
    selected: { personId: 'P-Li', deviceId: 'EXO-12', stationId: 'S4' },
    priority: {
      level: 'high',
      score: 42,
      factors: [
        { key: 'deadline_risk', label: '交期风险', value: 0.8 },
        { key: 'event_severity', label: '事件严重度', value: 0.5 },
      ],
    },
    candidates: [
      { personId: 'P-Li', deviceId: 'EXO-12', stationId: 'S4', score: 10, reasons: [] },
      { personId: 'P-John', deviceId: 'EXO-17', stationId: 'S4', score: 28, reasons: ['BODY_LOAD'] },
    ],
    selectedReason: ['负荷均衡：选中 P-Li 降低最大负荷'],
    rejectedAlternatives: [
      { personId: 'P-John', deviceId: 'EXO-17', stationId: 'S4', reason: ['BODY_LOAD', 'MAX_WORKLOAD'] },
    ],
    rejectedHard: [
      { personId: 'P-Zhao', deviceId: null, stationId: null, rejectReasons: ['missing_skill'] },
    ],
    hardConstraints: ['REQUIRED_SKILL'],
    // 真实键名（候选引擎写入 camelCase：latenessMs/travelMs/…，不是策略权重的 UPPER_SNAKE）
    softCosts: { latenessMs: 1500, travelMs: 2000 },
    weightsSnapshot: { lateness: 1, travel: 1 },
    policyVersion: 7,
    solverVersion: 'cp-sat-v3',
    snapshotVersion: 'WS-9',
    ...overrides,
  };
}

function makeConflict(overrides: Partial<SchedulingConflict> = {}): SchedulingConflict {
  return {
    conflictId: 'CFL-1',
    type: 'device_offline',
    severity: 'high',
    scope: 'resource',
    resourceId: 'D-1',
    resourceType: 'device',
    taskIds: ['T381'],
    message: '设备 EXO-17 离线，T381 原分配不可用',
    resolution: '改派给在线设备 EXO-12 并重排',
    createdAt: '2026-08-10T06:00:00.000Z',
    snapshotVersion: 'WS-9',
    data: {},
    status: 'OPEN',
    ...overrides,
  };
}

function makeCandidates(): TaskCandidatesResponse {
  return {
    taskId: 'T381',
    taskTitle: '搬运 A 线',
    taskStatus: 'open',
    assigned: true,
    lockedAssigneeId: null,
    lockedDeviceId: null,
    solverVersion: 'cp-sat-v3',
    generatedAt: '2026-08-10T07:30:00.000Z',
    candidates: [
      { personId: 'P-Li', personName: 'Li', deviceId: 'EXO-12', stationId: 'S4', eligible: true, etaSeconds: 60, distanceMeters: 40, skillMatch: true, workload: 0.3, batteryPct: 88, reservationConflict: false, score: 10, reasons: [] },
      { personId: 'P-John', personName: 'John', deviceId: 'EXO-17', stationId: 'S4', eligible: false, etaSeconds: 90, distanceMeters: 120, skillMatch: true, workload: 0.9, batteryPct: 55, reservationConflict: true, score: Number.POSITIVE_INFINITY, reasons: ['device_offline'], rejectReasons: ['device_offline'] },
    ],
  };
}

function makeImpact(): ReplanImpact {
  return {
    triggerType: 'DEVICE_OFFLINE',
    triggerIds: ['D-1'],
    affectedTaskIds: ['T381', 'T382'],
    affectedResourceIds: ['D-1'],
    affectedPersonIds: [],
    affectedDeviceIds: ['D-1'],
    affectedStationIds: [],
    affectedZoneIds: [],
    frozenAssignmentIds: ['T400'],
    movableAssignmentIds: ['T381'],
    reasons: ['DEVICE_OFFLINE:D-1', 'ROUTE_BLOCKED:R-7'],
    snapshotVersion: 'WS-9',
    baselinePlanVersion: 1,
  };
}

function makeDiff(): PlanCompareResult {
  const taskDiff: PlanAssignmentDiff = {
    taskId: 'T381',
    changeTypes: ['PERSON_CHANGED', 'DEVICE_CHANGED'],
    before: { taskId: 'T381', personId: 'P-John', deviceId: 'EXO-17', stationId: 'S4', plannedStart: '2026-08-10T08:00:00.000Z', plannedEnd: '2026-08-10T09:00:00.000Z' },
    after: { taskId: 'T381', personId: 'P-Li', deviceId: 'EXO-12', stationId: 'S4', plannedStart: '2026-08-10T08:00:00.000Z', plannedEnd: '2026-08-10T09:00:00.000Z' },
    reasons: ['DEVICE_OFFLINE:D-1'],
  };
  return {
    baselinePlanId: 'PLAN-1',
    candidatePlanId: 'PLAN-2',
    added: [],
    removed: [],
    diffByTask: [taskDiff],
    changeTypeCounts: {
      ADDED: 0,
      REMOVED: 0,
      PERSON_CHANGED: 1,
      DEVICE_CHANGED: 1,
      STATION_CHANGED: 0,
      TIME_CHANGED: 0,
      ROUTE_CHANGED: 0,
      ETA_CHANGED: 0,
      DISTANCE_CHANGED: 0,
      WORKLOAD_CHANGED: 0,
      LATENESS_CHANGED: 0,
      RISK_CHANGED: 0,
      CONFLICT_CHANGED: 0,
      CHURN: 0,
    },
    churn: 1,
    aggregate: {},
  };
}

function baseInput(): DecisionContextInput {
  return {
    taskId: 'T381',
    plan: makePlan(),
    trace: makeTrace(),
    conflict: makeConflict(),
    candidates: makeCandidates(),
    replanImpact: makeImpact(),
    planDiff: makeDiff(),
    taskDiff: makeDiff().diffByTask[0],
    feedback: null,
    unchangedTaskCount: 9,
    availableActions: ['accept', 'compare', 'override', 'lock', 'exclude', 'locate', 'undo'],
  };
}

function sectionById(vm: NonNullable<ReturnType<typeof decisionContextVM>>, id: string) {
  const s = vm.sections.find((x) => x.id === id);
  expect(s).toBeDefined();
  return s!;
}

describe('decisionContextVM：9 段决策上下文映射', () => {
  it('WHAT_HAPPENED 直映冲突字段（类型/描述/状态/触发类型）', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'WHAT_HAPPENED').rows;
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('冲突类型');
    expect(labels).toContain('冲突描述');
    const typeRow = rows.find((r) => r.label === '冲突类型')!;
    expect(typeRow.value).toContain('device_offline');
    const triggerRow = rows.find((r) => r.label === '触发类型')!;
    expect(triggerRow.value).toBe('设备离线');
  });

  it('WHY 原因链按服务端顺序映射（DEVICE_OFFLINE → ROUTE_BLOCKED）', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'WHY').rows;
    const chain = rows.find((r) => r.label === '原因链')!;
    // 触发码的实体后缀保留（D-1 是哪台设备、R-7 是哪条路线）
    expect(chain.value).toBe('设备离线（D-1） → 路线阻断（R-7）');
  });

  it('IMPACT 直映 ReplanImpact 计数与 PlanCompareResult 计数', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'IMPACT').rows;
    expect(rows.find((r) => r.label === '受影响任务')!.value).toBe('2');
    expect(rows.find((r) => r.label === '可移动任务')!.value).toBe('1');
    expect(rows.find((r) => r.label === '冻结任务')!.value).toBe('1');
    expect(rows.find((r) => r.label === '变更任务')!.value).toBe('1');
    expect(rows.find((r) => r.label === '未变化任务')!.value).toBe('9');
  });

  it('SYSTEM_DECISION 直映方案字段（含求解器状态映射）', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'SYSTEM_DECISION').rows;
    expect(rows.find((r) => r.label === '方案')!.value).toBe('方案 B');
    expect(rows.find((r) => r.label === '求解器状态')!.value).toBe('CP-SAT 最优解');
    expect(rows.find((r) => r.label === '策略版本')!.value).toBe('7');
    expect(vm.versions.solverVersion).toBe('cp-sat-v3');
  });

  it('WHY_THIS_ASSIGNMENT 直映 selectedReason + priority.factors', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'WHY_THIS_ASSIGNMENT').rows;
    expect(rows.find((r) => r.label === '选中原因')!.value).toContain('负荷均衡');
    const factors = rows.find((r) => r.label === '优先级因子')!;
    expect(factors.value).toContain('交期风险');
    expect(factors.value).toContain('事件严重度');
  });

  it('WHY_NOT_OTHERS 直映 rejectedAlternatives + rejectedHard + 候选计数', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'WHY_NOT_OTHERS').rows;
    expect(rows.find((r) => r.label === '候选总数')!.value).toBe('2');
    expect(rows.find((r) => r.label === '硬约束拒绝数')!.value).toBe('1');
    const alt = rows.find((r) => r.label.includes('P-John'))!;
    expect(alt.value).toContain('负荷超限'); // MAX_WORKLOAD → 负荷超限（decisionReasonLabel）
    const hard = rows.find((r) => r.label.includes('P-Zhao'))!;
    expect(hard.value).toContain('缺少技能'); // missing_skill → 缺少技能
  });

  it('COST 直映方案 metrics + trace.softCosts', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'COST').rows;
    expect(rows.find((r) => r.label === '预计延期')!.value).toBe('12 min');
    expect(rows.find((r) => r.label === '人员总移动')!.value).toBe('310 m');
    // 软成本键现在经唯一词表中文化（此前显示裸键 latenessMs/travelMs）
    const soft = rows.find((r) => r.label === '软成本 · 迟到')!;
    expect(soft.value).toBe('1500.00');
    const travel = rows.find((r) => r.label === '软成本 · 行走')!;
    expect(travel.value).toBe('2000.00');
  });

  it('RECOMMENDED_ACTION 直映 conflict.resolution', () => {
    const vm = decisionContextVM(baseInput())!;
    const rows = sectionById(vm, 'RECOMMENDED_ACTION').rows;
    expect(rows.find((r) => r.label === '建议处置')!.value).toContain('EXO-12');
  });

  it('ACTIONS 按 availableActions 映射文案', () => {
    const input = baseInput();
    input.availableActions = ['compare', 'undo'];
    const vm = decisionContextVM(input)!;
    const rows = sectionById(vm, 'ACTIONS').rows;
    expect(rows.map((r) => r.label)).toEqual(['方案对比', '清除上下文']);
  });

  it('无任务/方案/冲突/影响上下文 → null（空态）', () => {
    const input = baseInput();
    input.taskId = null;
    input.plan = null;
    input.conflict = null;
    input.replanImpact = null;
    input.trace = null;
    expect(decisionContextVM(input)).toBeNull();
  });

  it('仅服务端字段映射，不产生任何派生计算（硬约束数/候选数来自服务端数组）', () => {
    const input = baseInput();
    // 只给 trace（无 candidates/conflict/diff）：候选总数回退 trace.candidates.length。
    input.candidates = null;
    input.conflict = null;
    input.replanImpact = null;
    input.planDiff = null;
    input.taskDiff = null;
    const vm = decisionContextVM(input)!;
    const rows = sectionById(vm, 'WHY_NOT_OTHERS').rows;
    expect(rows.find((r) => r.label === '候选总数')!.value).toBe('2'); // trace.candidates.length
    expect(rows.find((r) => r.label === '硬约束拒绝数')!.value).toBe('1'); // trace.rejectedHard.length
  });
});
