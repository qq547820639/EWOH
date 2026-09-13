/* M05：Replan 叠加层 / DecisionTrace 解释 VM 纯函数测试。
 *
 * 关键不变量：前端只渲染服务端数据——replanOverlayVM 与 decisionExplainVM
 * 均不 import 任何 hard 判定逻辑（资格/成本/优先级重算），仅透传后端字段。
 */
import { replanChangeOverlay, diffStatus, humanLockedTaskIds } from './replanOverlayVM';
import { decisionExplainVM, decisionReasonLabel } from './vm/decisionExplainVM';
import type {
  PlanAssignmentDiff,
  ReplanPreviewResult,
  SchedulingConstraint,
  WorldStateSnapshot,
} from '@shared/api.interface';

const SNAPSHOT: WorldStateSnapshot = {
  snapshotVersion: 'WS-TEST',
  ts: '2026-08-10T00:00:00.000Z',
  worldVersion: 1,
  entityVersions: {},
  reservations: [],
  persons: [],
  tasks: [],
  devices: [],
  stations: [],
  backlog: [],
  events: [],
  routeStatus: [],
  forbiddenZones: [],
  lockedAssignments: [],
};

describe('M05 replanOverlayVM', () => {
  it('changedAssignments → changed-by-replan 集合（MOVED/ADDED/REMOVED 映射）', () => {
    const preview: ReplanPreviewResult = {
      baselinePlanId: 'B',
      candidatePlanId: 'C',
      readonly: true,
      affectedTaskCount: 3,
      unchangedAssignmentCount: 0,
      changedAssignmentCount: 3,
      addedAssignmentCount: 1,
      removedAssignmentCount: 1,
      latenessDelta: 0,
      travelDelta: 0,
      workloadDelta: 0,
      stationWaitDelta: 0,
      changeoverDelta: 0,
      energyRiskDelta: 0,
      riskDelta: 0,
      churnDelta: 0,
      changedAssignments: [
        {
          taskId: 't-moved',
          changeTypes: ['PERSON_CHANGED'],
          reasons: ['person p1 → p2'],
        } as PlanAssignmentDiff,
        {
          taskId: 't-added',
          changeTypes: ['ADDED'],
          reasons: ['assignment added'],
        } as PlanAssignmentDiff,
        {
          taskId: 't-removed',
          changeTypes: ['REMOVED'],
          reasons: ['assignment removed'],
        } as PlanAssignmentDiff,
      ],
    };
    const overlay = replanChangeOverlay(preview);
    expect(overlay.size).toBe(3);
    expect(overlay.get('t-moved')?.status).toBe('MOVED');
    expect(overlay.get('t-added')?.status).toBe('ADDED');
    expect(overlay.get('t-removed')?.status).toBe('REMOVED');
    expect(overlay.get('t-moved')?.color).toBe('#f59e0b');
    expect(overlay.get('t-added')?.color).toBe('#22c55e');
  });

  it('diffStatus：ADDED/REMOVED 优先，其余有变更 → MOVED，无变更 → UNCHANGED', () => {
    expect(diffStatus({ taskId: 'a', changeTypes: ['REMOVED'], reasons: [] })).toBe('REMOVED');
    expect(diffStatus({ taskId: 'b', changeTypes: ['ADDED'], reasons: [] })).toBe('ADDED');
    expect(diffStatus({ taskId: 'c', changeTypes: ['TIME_CHANGED'], reasons: [] })).toBe('MOVED');
    expect(diffStatus({ taskId: 'd', changeTypes: [], reasons: [] })).toBe('UNCHANGED');
  });

  it('humanLockedTaskIds：lockedAssignments + LOCKED_* 约束', () => {
    const snapshot: WorldStateSnapshot = {
      ...SNAPSHOT,
      lockedAssignments: [{ taskId: 't-lock', personId: 'p1', deviceId: null, stationId: null }],
    };
    const constraints: SchedulingConstraint[] = [
      { type: 'LOCKED_STATION', taskId: 't-station' },
      { type: 'REQUIRED_SKILL', taskId: 't-skill' }, // 非 LOCKED，不应计入
    ];
    const ids = humanLockedTaskIds(snapshot, constraints);
    expect(ids.has('t-lock')).toBe(true);
    expect(ids.has('t-station')).toBe(true);
    expect(ids.has('t-skill')).toBe(false);
  });
});

describe('M05 decisionExplainVM', () => {
  it('DecisionTrace → 展示模型：rejectedHard 结构化 + 可读文案', () => {
    const vm = decisionExplainVM({
      taskId: 't1',
      selected: { personId: 'p1', deviceId: null, stationId: 'S1' },
      priority: {
        level: 'urgent',
        score: 3.5,
        factors: [{ key: 'deadline_risk', label: 'deadline_risk', value: 2.5 }],
      },
      candidates: [],
      selectedReason: ['ok'],
      rejectedAlternatives: [],
      policyVersion: 1,
      solverVersion: 'heuristic-v2',
      snapshotVersion: 'WS-TEST',
      rejectedHard: [
        { personId: 'p9', deviceId: null, stationId: null, rejectReasons: ['REQUIRED_CERTIFICATION'] },
        { personId: 'p8', deviceId: 'd9', stationId: null, rejectReasons: ['MIN_BATTERY', 'ROUTE_BLOCKED'] },
      ],
      hardConstraints: ['REQUIRED_CERTIFICATION', 'MIN_BATTERY'],
      softCosts: { latenessMs: 10 },
      weightsSnapshot: { lateness: 1 },
      stationContribution: { stationId: 'S1', queueLength: 2, changeover: false },
    });
    expect(vm).not.toBeNull();
    expect(vm!.priorityLevel).toBe('urgent');
    expect(vm!.rejectedHard).toHaveLength(2);
    expect(vm!.rejectedHard[0].reasonLabels).toContain('缺少证书');
    // MIN_BATTERY 现在同时覆盖"电量低"与"电量未知"（未知电量 fail-closed 不派工），
    // 文案必须如实反映两种情形，不能只说"不足"。
    expect(vm!.rejectedHard[1].reasonLabels).toContain('电量不足或未知');
    expect(vm!.hardConstraints).toContain('MIN_BATTERY');
  });

  it('decisionReasonLabel：已知码映射中文，未知码显式标注未登记（不重算不臆造）', () => {
    expect(decisionReasonLabel('REQUIRED_CERTIFICATION')).toBe('缺少证书');
    expect(decisionReasonLabel('SOME_UNKNOWN_REASON')).toBe('未登记原因（SOME_UNKNOWN_REASON）');
  });

  it('null DecisionTrace → null', () => {
    expect(decisionExplainVM(null)).toBeNull();
    expect(decisionExplainVM(undefined)).toBeNull();
  });
});
