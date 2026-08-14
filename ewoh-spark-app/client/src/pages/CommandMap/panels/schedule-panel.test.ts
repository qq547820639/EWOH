/* P1-5 Production Demo 隔离测试：演示方案识别（不可审批/驳回/派工）。 */
import { isNonAuthoritativePlan } from './schedule-panel-demo';
import {
  replanPreviewSummary,
  dispatchPlanSummary,
  pickPreviousApprovedPlanId,
} from './schedule-panel-logic';
import type { ReplanPreviewResult, SchedulingPlanV2 } from '@shared/api.interface';

describe('P1-5 isNonAuthoritativePlan（演示方案识别）', () => {
  it('planId 以 DEMO 开头 → 非权威（禁止审批/派工）', () => {
    expect(isNonAuthoritativePlan({ planId: 'DEMO-123', snapshotVersion: 'WS-1' })).toBe(true);
  });

  it('snapshotVersion 为 demo-snapshot → 非权威', () => {
    expect(isNonAuthoritativePlan({ planId: 'PLAN-1', snapshotVersion: 'demo-snapshot' })).toBe(true);
  });

  it('正常方案（无 DEMO 前缀、非 demo snapshot）→ 权威可操作', () => {
    expect(
      isNonAuthoritativePlan({ planId: 'PLAN-abc', snapshotVersion: 'WS-20260808-0001' }),
    ).toBe(false);
  });

  it('null → 非权威（无方案不可操作）', () => {
    expect(isNonAuthoritativePlan(null)).toBe(false);
  });
});

const makePreview = (overrides: Partial<ReplanPreviewResult> = {}): ReplanPreviewResult => ({
  baselinePlanId: 'PLAN-BASE',
  candidatePlanId: 'PREVIEW-123',
  readonly: true,
  affectedTaskCount: 5,
  unchangedAssignmentCount: 20,
  changedAssignmentCount: 4,
  addedAssignmentCount: 1,
  removedAssignmentCount: 2,
  latenessDelta: -12,
  travelDelta: -40,
  workloadDelta: 0.05,
  stationWaitDelta: -3,
  changeoverDelta: 0,
  energyRiskDelta: 0,
  riskDelta: -0.1,
  churnDelta: 4,
  changedAssignments: [],
  ...overrides,
});

const makePlan = (overrides: Partial<SchedulingPlanV2> = {}): SchedulingPlanV2 => ({
  planId: 'PLAN-1',
  planName: '方案A',
  version: 2,
  status: 'approved',
  trigger: { type: 'MANUAL', entityId: null },
  snapshotVersion: 'WS-20260810-0001',
  policyVersion: 3,
  solverVersion: 'cp-sat-v2',
  solverStatus: 'OPTIMAL',
  horizonMinutes: 480,
  assignments: [
    {
      assignmentId: 'a1',
      taskId: 'T-1',
      personId: 'P-1',
      deviceId: null,
      stationId: 'W-1',
      zoneId: null,
      plannedStart: '2026-08-10T08:00:00.000Z',
      plannedEnd: '2026-08-10T09:00:00.000Z',
      routeId: null,
      status: 'proposed',
      reasons: [],
      alternatives: [],
    },
  ],
  metrics: { lateMinutes: 5, walkingMeters: 320, stationWaitMinutes: 8, maxWorkload: 0.72, changeCost: 2 },
  baselineDelta: {},
  violations: [],
  createdAt: '2026-08-10T07:00:00.000Z',
  ...overrides,
});

describe('Task 10 replanPreviewSummary（REPLAN 确认框预览摘要）', () => {
  it('从 mock 预览响应派生计数与增量行（仅展示后端字段）', () => {
    const summary = replanPreviewSummary(makePreview())!;
    expect(summary).not.toBeNull();
    expect(summary.affectedTaskCount).toBe(5);
    expect(summary.changedAssignmentCount).toBe(4);
    expect(summary.unchangedAssignmentCount).toBe(20);
    expect(summary.addedAssignmentCount).toBe(1);
    expect(summary.removedAssignmentCount).toBe(2);
    expect(summary.deltas.map((d) => d.key)).toEqual([
      'lateness',
      'travel',
      'workload',
      'stationWait',
      'risk',
      'churn',
    ]);
    expect(summary.deltas[0]).toMatchObject({ label: '迟到', value: -12, unit: 'min' });
    expect(summary.deltas[5]).toMatchObject({ key: 'churn', value: 4 });
  });

  it('delta 缺失字段按 0 兜底（缺省渲染不崩）', () => {
    const summary = replanPreviewSummary(makePreview({ latenessDelta: undefined as never }))!;
    expect(summary.deltas.find((d) => d.key === 'lateness')?.value).toBe(0);
  });

  it('无 preview → null（确认按钮禁用，仅确认后才会执行 replan）', () => {
    expect(replanPreviewSummary(null)).toBeNull();
    expect(replanPreviewSummary(undefined)).toBeNull();
  });
});

describe('Task 10 dispatchPlanSummary（DISPATCH 确认框方案摘要）', () => {
  it('汇总分配数/指标/求解器/快照与策略版本', () => {
    const summary = dispatchPlanSummary(makePlan())!;
    expect(summary).toMatchObject({
      planId: 'PLAN-1',
      version: 2,
      assignmentsCount: 1,
      lateMinutes: 5,
      walkingMeters: 320,
      stationWaitMinutes: 8,
      maxWorkload: 0.72,
      solverStatus: 'OPTIMAL',
      solverVersion: 'cp-sat-v2',
      snapshotVersion: 'WS-20260810-0001',
      policyVersion: 3,
    });
  });

  it('无方案 → null', () => {
    expect(dispatchPlanSummary(null)).toBeNull();
    expect(dispatchPlanSummary(undefined)).toBeNull();
  });
});

describe('pickPreviousApprovedPlanId（上一已批准方案回看对比目标）', () => {
  const makePlan = (overrides: Partial<SchedulingPlanV2>): SchedulingPlanV2 =>
    ({
      planId: 'PLAN-1',
      status: 'shadow',
      createdAt: '2026-08-14T10:00:00.000Z',
      ...overrides,
    }) as SchedulingPlanV2;

  it('无选中方案 → null', () => {
    expect(pickPreviousApprovedPlanId([makePlan({ planId: 'A' })], null)).toBeNull();
  });

  it('候选取最近时间的已批准/已派工/被替代方案（不兜底列表首个）', () => {
    const plans = [
      makePlan({ planId: 'CUR', status: 'shadow', createdAt: '2026-08-14T10:00:00.000Z' }),
      makePlan({ planId: 'OLD-SUP', status: 'superseded', createdAt: '2026-08-14T09:30:00.000Z' }),
      makePlan({ planId: 'OLD-DISP', status: 'dispatched', createdAt: '2026-08-14T09:00:00.000Z' }),
      makePlan({ planId: 'SHADOW-2', status: 'shadow', createdAt: '2026-08-14T09:50:00.000Z' }),
    ];
    expect(pickPreviousApprovedPlanId(plans, 'CUR')).toBe('OLD-SUP');
  });

  it('无候选（仅当前方案/仅影子方案）→ null', () => {
    const plans = [
      makePlan({ planId: 'CUR', status: 'shadow' }),
      makePlan({ planId: 'OTHER', status: 'shadow', createdAt: '2026-08-14T09:00:00.000Z' }),
    ];
    expect(pickPreviousApprovedPlanId(plans, 'CUR')).toBeNull();
  });
});
