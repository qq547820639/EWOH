/* decision-projection.spec.ts — Canonical Decision Model 生产投影（NO-12y / ADR-048）。
 *
 * DecisionTrace（求解内嵌形状）→ DecisionRecord（ADR-047 契约形态）唯一投影点：
 * 等价断言（trace 字段 → 记录字段逐字一致）+ 契约校验通过 + 缺口显式 +
 * ID 确定性 + 风险映射规则锁定（ADR-048 决策 2）。
 */
import type { DecisionTrace, SchedulingPlanV2 } from '@shared/scheduler';
import { validateDecision } from '@shared/decision';
import {
  comboOptionId,
  mapAgentRiskToDecisionRisk,
  mapRouteRiskToDecisionRisk,
  maxDecisionRisk,
  projectAgentApprovalDecision,
  projectDispatchDecision,
  projectLearningProposalActivationDecision,
  projectPlanApprovalDecision,
  projectPolicyActivationDecision,
  projectPlanDecisionRecords,
  projectReplanDecision,
  projectResourceReservationDecision,
  projectTaskAssignmentDecision,
  replanRiskForTrigger,
} from '../../../server/modules/scheduler/decision-projection';

const CTX = { userId: 'tester', primaryOrgId: 'ORG-1' } as never;

function makeTrace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    taskId: 'task:t-1001',
    selected: { personId: 'person:p1', deviceId: 'device:exo-1', stationId: 'station:s1' },
    priority: { level: 'HIGH', score: 88, factors: [{ key: 'k', label: 'k', value: 1 }] },
    candidates: [
      {
        personId: 'person:p1',
        deviceId: 'device:exo-1',
        stationId: 'station:s1',
        score: 92.5,
        reasons: ['skill-match', 'low-fatigue'],
      },
      { personId: 'person:p2', deviceId: null, stationId: 'station:s1', score: 71, reasons: [] },
    ],
    selectedReason: ['highest-score', 'skill-match'],
    rejectedAlternatives: [
      {
        personId: 'person:p2',
        deviceId: null,
        stationId: 'station:s1',
        reason: ['lower-score'],
      },
    ],
    policyVersion: 8,
    solverVersion: 'heuristic-v2',
    snapshotVersion: 'world:v42',
    rejectedHard: [
      {
        personId: 'person:p3',
        deviceId: null,
        stationId: null,
        rejectReasons: ['certification-expired'],
      },
    ],
    hardConstraints: ['skill-match', 'certification-valid'],
    weightsSnapshot: { on_time: 0.4, workload: 0.3 },
    ...overrides,
  };
}

function makePlan(overrides: Partial<SchedulingPlanV2> = {}): SchedulingPlanV2 {
  return {
    planId: 'PLAN-1',
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'world:v42',
    policyVersion: 8,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [
      {
        assignmentId: 'ASG-1',
        taskId: 'task:t-1001',
        personId: 'person:p1',
        deviceId: 'device:exo-1',
        stationId: 'station:s1',
        zoneId: null,
        plannedStart: '2026-08-16T08:00:00Z',
        plannedEnd: '2026-08-16T08:30:00Z',
        routeId: null,
        status: 'proposed',
        riskLevel: null,
        reasons: [],
        alternatives: [],
        decisionTrace: makeTrace(),
      },
    ],
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: '2026-08-16T08:00:00Z',
    ...overrides,
  };
}

describe('decision-projection（ADR-048 唯一投影点）', () => {
  it('字段等价：trace → DecisionRecord 逐字一致（selectedReason/候选评分/拒绝原因/约束/权重/版本）', () => {
    const trace = makeTrace();
    const plan = makePlan();
    const { record, issues } = projectTaskAssignmentDecision(
      trace,
      { assignmentId: 'ASG-1', riskLevel: null },
      plan,
      CTX,
    );
    expect(issues).toEqual([]);
    expect(record).not.toBeNull();
    expect(record?.decisionId).toBe('decision:PLAN-1:task:t-1001');
    expect(record?.kind).toBe('task_assignment');
    expect(record?.status).toBe('proposed');
    expect(record?.decisionAuthority).toBe('optimization');
    expect(record?.subject).toBe('task:task:t-1001');
    expect(record?.tenantId).toBe('ORG-1');
    expect(record?.requiresApproval).toBe(true);
    expect(record?.decidedAt).toBe('2026-08-16T08:00:00.000Z');
    expect(record?.policyVersion).toBe('8');
    expect(record?.solverVersion).toBe('heuristic-v2');
    expect(record?.snapshotRef).toBe('world:v42');
    expect(record?.options).toEqual([
      {
        optionId: 'opt:person:p1:device:exo-1:station:s1',
        score: 92.5,
        reasons: ['skill-match', 'low-fatigue'],
      },
      { optionId: 'opt:person:p2:none:station:s1', score: 71, reasons: [] },
    ]);
    expect(record?.selected).toEqual({
      optionId: 'opt:person:p1:device:exo-1:station:s1',
      reason: ['highest-score', 'skill-match'],
    });
    expect(record?.rejectedAlternatives).toEqual([
      { optionId: 'opt:person:p2:none:station:s1', rejectReasons: ['lower-score'] },
      { optionId: 'opt:person:p3:none:none', rejectReasons: ['certification-expired'] },
    ]);
    expect(record?.hardConstraints).toEqual(['skill-match', 'certification-valid']);
    expect(record?.weightsSnapshot).toEqual({ on_time: 0.4, workload: 0.3 });
    expect(record?.auditTrail).toEqual([
      { actor: 'solver:heuristic-v2', action: 'decided', at: '2026-08-16T08:00:00.000Z' },
    ]);
    // §31：投影产出必过契约门（共享 validateDecision 实现）。
    expect(validateDecision(record)).toEqual([]);
  });

  it('风险映射规则（ADR-048 决策 2）：route 风险事实 → 决策阶梯（null=路径无被标记风险边 → low）', () => {
    expect(mapRouteRiskToDecisionRisk('high')).toBe('high');
    expect(mapRouteRiskToDecisionRisk('medium')).toBe('medium');
    expect(mapRouteRiskToDecisionRisk(null)).toBe('low');
    for (const risk of ['high', 'medium', null]) {
      const { record, issues } = projectTaskAssignmentDecision(
        makeTrace(),
        { assignmentId: 'ASG-1', riskLevel: risk },
        makePlan(),
        CTX,
      );
      expect(issues).toEqual([]);
      expect(record?.riskLevel).toBe(mapRouteRiskToDecisionRisk(risk));
    }
  });

  it('ID/optionId 确定性（幂等：同输入 → 同输出）', () => {
    const a = projectTaskAssignmentDecision(
      makeTrace(),
      { assignmentId: 'ASG-1', riskLevel: null },
      makePlan(),
      CTX,
    );
    const b = projectTaskAssignmentDecision(
      makeTrace(),
      { assignmentId: 'ASG-1', riskLevel: null },
      makePlan(),
      CTX,
    );
    expect(a.record).toEqual(b.record);
    expect(comboOptionId('person:p1', null, 'station:s1')).toBe('opt:person:p1:none:station:s1');
  });

  it('baseline reuse 快速路径：selected 组合不在 candidates → 补入 options（契约不变式 selected∈options，语义不变）', () => {
    const trace = makeTrace({
      candidates: [
        { personId: 'person:p2', deviceId: null, stationId: 'station:s1', score: 71, reasons: [] },
      ],
    });
    const { record, issues } = projectTaskAssignmentDecision(
      trace,
      { assignmentId: 'ASG-1', riskLevel: null },
      makePlan(),
      CTX,
    );
    expect(issues).toEqual([]);
    const selectedId = 'opt:person:p1:device:exo-1:station:s1';
    expect(record?.selected.optionId).toBe(selectedId);
    expect(record?.options?.some((o) => o.optionId === selectedId)).toBe(true);
    expect(record?.options?.find((o) => o.optionId === selectedId)).toEqual({
      optionId: selectedId,
      score: null,
      reasons: ['highest-score', 'skill-match'],
    });
    expect(validateDecision(record)).toEqual([]);
  });

  it('显式缺口（§33 绝不静默/绝不伪造）：无租户 / 无 selectedReason / 无 trace', () => {
    const noTenant = projectTaskAssignmentDecision(
      makeTrace(),
      { assignmentId: 'ASG-1', riskLevel: null },
      makePlan(),
      { userId: 'tester', primaryOrgId: '' } as never,
    );
    expect(noTenant).toEqual({ record: null, issues: ['decision_tenant_unknown'] });

    const noReason = projectTaskAssignmentDecision(
      makeTrace({ selectedReason: ['  ', ''] }),
      { assignmentId: 'ASG-1', riskLevel: null },
      makePlan(),
      CTX,
    );
    expect(noReason).toEqual({ record: null, issues: ['decision_no_selected_reason'] });

    const planWithoutTrace = makePlan({
      assignments: [
        {
          assignmentId: 'ASG-2',
          taskId: 'task:t-2',
          personId: 'person:p1',
          deviceId: null,
          stationId: null,
          zoneId: null,
          plannedStart: null,
          plannedEnd: null,
          routeId: null,
          status: 'proposed',
          reasons: [],
          alternatives: [],
          decisionTrace: undefined,
        },
      ],
    });
    const projected = projectPlanDecisionRecords(planWithoutTrace, CTX);
    expect(projected.records).toEqual([]);
    expect(projected.issues).toEqual([{ assignmentId: 'ASG-2', reason: 'decision_no_trace' }]);
  });

  it('空原因过滤（不伪造）：rejected/rejectedHard 空 rejectReasons 条目被跳过', () => {
    const trace = makeTrace({
      rejectedAlternatives: [
        { personId: 'person:p2', deviceId: null, stationId: 'station:s1', reason: [''] },
      ],
      rejectedHard: [
        { personId: 'person:p3', deviceId: null, stationId: null, rejectReasons: ['', ' '] },
      ],
    });
    const { record, issues } = projectTaskAssignmentDecision(
      trace,
      { assignmentId: 'ASG-1', riskLevel: null },
      makePlan(),
      CTX,
    );
    expect(issues).toEqual([]);
    expect(record?.rejectedAlternatives).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
  });

  it('方案级投影：多 assignment 全部产出 + 非有限权重过滤', () => {
    const plan = makePlan({
      assignments: [
        makePlan().assignments[0],
        {
          assignmentId: 'ASG-2',
          taskId: 'task:t-2',
          personId: 'person:p2',
          deviceId: null,
          stationId: 'station:s1',
          zoneId: null,
          plannedStart: '2026-08-16T09:00:00Z',
          plannedEnd: '2026-08-16T09:30:00Z',
          routeId: null,
          status: 'proposed',
          riskLevel: 'medium',
          reasons: [],
          alternatives: [],
          decisionTrace: makeTrace({
            taskId: 'task:t-2',
            selected: { personId: 'person:p2', deviceId: null, stationId: 'station:s1' },
            selectedReason: ['skill-match'],
            weightsSnapshot: { on_time: 0.4, bad: Number.NaN },
          }),
        },
      ],
    });
    const projected = projectPlanDecisionRecords(plan, CTX);
    expect(projected.issues).toEqual([]);
    expect(projected.records).toHaveLength(2);
    expect(projected.records[1].riskLevel).toBe('medium');
    expect(projected.records[1].weightsSnapshot).toEqual({ on_time: 0.4 });
    for (const record of projected.records) {
      expect(validateDecision(record)).toEqual([]);
    }
  });
});

describe('projectPlanApprovalDecision（NO-13h / ADR-057：Decision Catalog kind #2）', () => {
  const NOW = new Date('2026-08-16T10:00:00Z');

  it('approve：契约门通过 + 判定事实完整（authority=human/approver/riskLevel=high/requiresApproval=false）', () => {
    const { record, issues } = projectPlanApprovalDecision(
      'PLAN-1', 1, 'approved', 'tester', '验证通过', CTX, NOW,
    );
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:PLAN-1:approval:v1');
    expect(record?.kind).toBe('plan_approval');
    expect(record?.status).toBe('approved');
    expect(record?.decisionAuthority).toBe('human');
    expect(record?.riskLevel).toBe('high');
    expect(record?.requiresApproval).toBe(false);
    expect(record?.subject).toBe('plan:PLAN-1');
    expect(record?.selected).toEqual({ optionId: 'opt:approve', reason: ['验证通过'] });
    expect(record?.approver).toEqual({ actor: 'user:tester', at: '2026-08-16T10:00:00.000Z' });
    expect(record?.auditTrail).toEqual([
      { actor: 'user:tester', action: 'approved', at: '2026-08-16T10:00:00.000Z' },
    ]);
  });

  it('reject：reason 缺省用结果动作词（事实非伪造）+ 幂等确定性', () => {
    const { record, issues } = projectPlanApprovalDecision(
      'PLAN-2', 3, 'rejected', 'tester', undefined, CTX, NOW,
    );
    expect(issues).toEqual([]);
    expect(record?.status).toBe('rejected');
    expect(record?.selected).toEqual({ optionId: 'opt:reject', reason: ['rejected'] });
    expect(validateDecision(record)).toEqual([]);
    const again = projectPlanApprovalDecision('PLAN-2', 3, 'rejected', 'tester', undefined, CTX, NOW);
    expect(again.record).toEqual(record);
  });

  it('缺口显式：无租户 / 无 operator → null + 显式理由（§33 不伪造）', () => {
    const noTenant = projectPlanApprovalDecision(
      'PLAN-1', 1, 'approved', 'tester', 'r', { userId: 'tester', primaryOrgId: '' } as never, NOW,
    );
    expect(noTenant).toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    const noOperator = projectPlanApprovalDecision(
      'PLAN-1', 1, 'approved', '  ', 'r', CTX, NOW,
    );
    expect(noOperator).toEqual({ record: null, issues: ['decision_no_operator'] });
  });
});

describe('projectAgentApprovalDecision（NO-13j / ADR-059：Decision Catalog kind #3）', () => {
  const NOW = new Date('2026-08-16T11:00:00Z');
  const BASE = {
    approvalId: 'appr-1',
    agentId: 'agent:a1',
    command: 'propose_plan',
    orgId: 'ORG-1',
    manifestRiskLevel: 'medium',
  };

  it('approved：契约门通过 + 判定事实完整（authority=human/approver/风险映射/evidence 原始档）', () => {
    const { record, issues } = projectAgentApprovalDecision({
      ...BASE, outcome: 'approved', operator: 'u1', reason: '值班长确认', now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:appr-1:agent-approval');
    expect(record?.kind).toBe('agent_approval');
    expect(record?.status).toBe('approved');
    expect(record?.decisionAuthority).toBe('human');
    expect(record?.subject).toBe('agent:agent:a1');
    expect(record?.tenantId).toBe('ORG-1');
    expect(record?.riskLevel).toBe('medium');
    expect(record?.requiresApproval).toBe(false);
    expect(record?.selected).toEqual({ optionId: 'opt:approve', reason: ['值班长确认'] });
    expect(record?.approver).toEqual({ actor: 'user:u1', at: '2026-08-16T11:00:00.000Z' });
    expect(record?.evidence).toEqual(['manifest_risk:medium', 'command:propose_plan']);
    expect(record?.auditTrail).toEqual([
      { actor: 'user:u1', action: 'approved', at: '2026-08-16T11:00:00.000Z' },
    ]);
  });

  it('rejected：人工驳回缺省理由 + 幂等确定性（同输入 → 同记录）', () => {
    const { record, issues } = projectAgentApprovalDecision({
      ...BASE, outcome: 'rejected', operator: 'u2', now: NOW,
    });
    expect(issues).toEqual([]);
    expect(record?.status).toBe('rejected');
    expect(record?.selected).toEqual({ optionId: 'opt:reject', reason: ['人工驳回'] });
    expect(record?.approver?.actor).toBe('user:u2');
    const again = projectAgentApprovalDecision({
      ...BASE, outcome: 'rejected', operator: 'u2', now: NOW,
    });
    expect(again.record).toEqual(record);
  });

  it('expired：TTL 策略解析（authority=policy，无需操作者）+ critical 档收敛留原始事实', () => {
    const { record, issues } = projectAgentApprovalDecision({
      ...BASE, manifestRiskLevel: 'critical', outcome: 'expired', now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.status).toBe('rejected');
    expect(record?.decisionAuthority).toBe('policy');
    expect(record?.riskLevel).toBe('high'); // critical 收敛到决策阶梯最高档
    expect(record?.evidence).toEqual(['manifest_risk:critical', 'command:propose_plan']);
    expect(record?.approver).toEqual({ actor: 'policy:agent-approval-ttl', at: '2026-08-16T11:00:00.000Z' });
    expect(record?.selected).toEqual({ optionId: 'opt:reject', reason: ['approval_expired'] });
  });

  it('风险映射规则（ADR-059 决策 1）：low/medium/high/critical → low/medium/high/high；未知 → null', () => {
    expect(mapAgentRiskToDecisionRisk('low')).toBe('low');
    expect(mapAgentRiskToDecisionRisk('medium')).toBe('medium');
    expect(mapAgentRiskToDecisionRisk('high')).toBe('high');
    expect(mapAgentRiskToDecisionRisk('critical')).toBe('high');
    expect(mapAgentRiskToDecisionRisk('bogus')).toBeNull();
    expect(mapAgentRiskToDecisionRisk(undefined)).toBeNull();
  });

  it('缺口显式（§33 不伪造）：无租户 / 人工解析缺 operator / 未知风险档 → null + 显式理由', () => {
    const noTenant = projectAgentApprovalDecision({
      ...BASE, orgId: '  ', outcome: 'approved', operator: 'u1', now: NOW,
    });
    expect(noTenant).toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    const noOperator = projectAgentApprovalDecision({
      ...BASE, outcome: 'approved', now: NOW,
    });
    expect(noOperator).toEqual({ record: null, issues: ['decision_no_operator'] });
    const unknownRisk = projectAgentApprovalDecision({
      ...BASE, manifestRiskLevel: 'bogus', outcome: 'rejected', operator: 'u1', now: NOW,
    });
    expect(unknownRisk).toEqual({ record: null, issues: ['decision_unknown_risk'] });
  });
});

describe('projectResourceReservationDecision（NO-13k / ADR-060：Decision Catalog kind #4）', () => {
  const NOW = new Date('2026-08-16T12:00:00Z');
  const RESERVATION = {
    reservationId: 'RSV-9',
    resourceType: 'person',
    resourceId: 'p1',
    startMs: 1000,
    endMs: 2000,
  };

  it('判定事实完整：executed/rule_based/台账链接/风险映射复用 ADR-048 规则（契约门通过）', () => {
    const { record, issues } = projectResourceReservationDecision({
      planId: 'PLAN-1',
      assignmentId: 'ASG-1',
      taskId: 'task:t1',
      reservation: RESERVATION,
      assignmentRiskLevel: 'high',
      orgId: 'ORG-1',
      operator: 'u1',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:PLAN-1:reservation:ASG-1:RSV-9');
    expect(record?.kind).toBe('resource_reservation');
    expect(record?.status).toBe('executed');
    expect(record?.decisionAuthority).toBe('rule_based');
    expect(record?.subject).toBe('resource:person:p1');
    expect(record?.riskLevel).toBe('high');
    expect(record?.requiresApproval).toBe(false);
    expect(record?.options).toEqual([
      { optionId: 'opt:reserve', reasons: ['1000-2000'] },
      { optionId: 'opt:skip', reasons: [] },
    ]);
    expect(record?.selected).toEqual({
      optionId: 'opt:reserve',
      reason: ['RSV-9:person:p1:1000-2000'],
    });
    expect(record?.evidence).toEqual(['assignment:ASG-1', 'task:task:t1']);
    expect(record?.auditTrail).toEqual([
      { actor: 'user:u1', action: 'reserved', at: '2026-08-16T12:00:00.000Z' },
    ]);
  });

  it('缺省操作者 → actor=system:dispatch（派工系统动作留痕，不伪造 human 身份）+ 幂等确定性', () => {
    const { record, issues } = projectResourceReservationDecision({
      planId: 'PLAN-1',
      assignmentId: 'ASG-2',
      taskId: null,
      reservation: RESERVATION,
      assignmentRiskLevel: null,
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(record?.riskLevel).toBe('low'); // null = 路径无被标记风险边（ADR-048 规则）
    expect(record?.evidence).toEqual(['assignment:ASG-2']);
    expect(record?.auditTrail?.[0].actor).toBe('system:dispatch');
    const again = projectResourceReservationDecision({
      planId: 'PLAN-1',
      assignmentId: 'ASG-2',
      taskId: null,
      reservation: RESERVATION,
      assignmentRiskLevel: null,
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(again.record).toEqual(record);
  });

  it('缺口显式（§33 不伪造）：无租户 / 缺判定事实 → null + 显式理由', () => {
    const noTenant = projectResourceReservationDecision({
      planId: 'PLAN-1',
      assignmentId: 'ASG-1',
      taskId: null,
      reservation: RESERVATION,
      assignmentRiskLevel: null,
      orgId: '  ',
      now: NOW,
    });
    expect(noTenant).toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    const noFacts = projectResourceReservationDecision({
      planId: '',
      assignmentId: 'ASG-1',
      taskId: null,
      reservation: { ...RESERVATION, reservationId: '' },
      assignmentRiskLevel: null,
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(noFacts).toEqual({ record: null, issues: ['decision_no_subject_facts'] });
  });
});

describe('projectDispatchDecision（NO-13l / ADR-061：Decision Catalog kind #5）', () => {
  const NOW = new Date('2026-08-16T13:00:00Z');

  it('判定事实完整：executed/policy/派工数/outbox 链接（契约门通过）', () => {
    const { record, issues } = projectDispatchDecision({
      planId: 'PLAN-1',
      assignmentRiskLevels: ['high', null, 'medium'],
      dispatchCount: 2,
      outboxEventIds: ['evt-1', 'evt-2'],
      orgId: 'ORG-1',
      operator: 'u1',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:PLAN-1:dispatch');
    expect(record?.kind).toBe('dispatch');
    expect(record?.status).toBe('executed');
    expect(record?.decisionAuthority).toBe('policy');
    expect(record?.subject).toBe('plan:PLAN-1');
    expect(record?.riskLevel).toBe('high'); // max 聚合：任一 high → high
    expect(record?.requiresApproval).toBe(false);
    expect(record?.options).toEqual([
      { optionId: 'opt:dispatch', reasons: ['assignments:2'] },
      { optionId: 'opt:hold', reasons: [] },
    ]);
    expect(record?.selected).toEqual({ optionId: 'opt:dispatch', reason: ['dispatched:2'] });
    expect(record?.evidence).toEqual(['assignments:2', 'outbox:evt-1', 'outbox:evt-2']);
    expect(record?.auditTrail).toEqual([
      { actor: 'user:u1', action: 'dispatched', at: '2026-08-16T13:00:00.000Z' },
    ]);
  });

  it('风险聚合 max 规则（ADR-061 决策 1）：high 优先 / medium 优先 / 全 low / 空集 low', () => {
    expect(maxDecisionRisk(['low', null, 'high'])).toBe('high');
    expect(maxDecisionRisk(['low', 'medium', null])).toBe('medium');
    expect(maxDecisionRisk(['low', null])).toBe('low');
    expect(maxDecisionRisk([])).toBe('low');
  });

  it('缺省操作者 → system:dispatch + 幂等确定性；缺口显式（无租户/缺 planId/非法派工数）', () => {
    const { record, issues } = projectDispatchDecision({
      planId: 'PLAN-2',
      assignmentRiskLevels: [],
      dispatchCount: 0,
      outboxEventIds: [],
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(record?.auditTrail?.[0].actor).toBe('system:dispatch');
    expect(record?.riskLevel).toBe('low');
    const again = projectDispatchDecision({
      planId: 'PLAN-2',
      assignmentRiskLevels: [],
      dispatchCount: 0,
      outboxEventIds: [],
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(again.record).toEqual(record);

    expect(projectDispatchDecision({
      planId: 'PLAN-2', assignmentRiskLevels: [], dispatchCount: 0,
      outboxEventIds: [], orgId: '  ', now: NOW,
    })).toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    expect(projectDispatchDecision({
      planId: '', assignmentRiskLevels: [], dispatchCount: 0,
      outboxEventIds: [], orgId: 'ORG-1', now: NOW,
    })).toEqual({ record: null, issues: ['decision_no_subject_facts'] });
    expect(projectDispatchDecision({
      planId: 'PLAN-2', assignmentRiskLevels: [], dispatchCount: -1,
      outboxEventIds: [], orgId: 'ORG-1', now: NOW,
    })).toEqual({ record: null, issues: ['decision_invalid_dispatch_count'] });
  });
});

describe('projectReplanDecision（NO-13m / ADR-062：Decision Catalog kind #6）', () => {
  const NOW = new Date('2026-08-16T14:00:00Z');

  it('判定事实完整：proposed/policy/触发类型+影响数/run 链接（契约门通过）', () => {
    const { record, issues } = projectReplanDecision({
      planId: 'RUN-1A',
      runId: 'RUN-1',
      triggerType: 'DEVICE_OFFLINE',
      triggerEntityId: 'd1',
      affectedCount: 3,
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:RUN-1A:replan');
    expect(record?.kind).toBe('replan');
    expect(record?.status).toBe('proposed');
    expect(record?.decisionAuthority).toBe('policy');
    expect(record?.subject).toBe('plan:RUN-1A');
    expect(record?.riskLevel).toBe('medium'); // DEVICE_OFFLINE 类型推导规则
    expect(record?.requiresApproval).toBe(true);
    expect(record?.options).toEqual([
      { optionId: 'opt:replan', reasons: ['trigger:DEVICE_OFFLINE'] },
      { optionId: 'opt:keep', reasons: [] },
    ]);
    expect(record?.selected).toEqual({
      optionId: 'opt:replan',
      reason: ['trigger:DEVICE_OFFLINE:affected:3'],
    });
    expect(record?.evidence).toEqual(['run:RUN-1', 'trigger:DEVICE_OFFLINE', 'affected:3', 'entity:d1']);
    expect(record?.auditTrail).toEqual([
      { actor: 'policy:replan-trigger', action: 'replanned', at: '2026-08-16T14:00:00.000Z' },
    ]);
  });

  it('风险类型推导规则（ADR-062 决策 1）：SAFETY_EVENT/ZONE_RESTRICTED→high、PERSON_UNAVAILABLE/DEVICE_OFFLINE→medium、其余→low', () => {
    expect(replanRiskForTrigger('SAFETY_EVENT')).toBe('high');
    expect(replanRiskForTrigger('ZONE_RESTRICTED')).toBe('high');
    expect(replanRiskForTrigger('PERSON_UNAVAILABLE')).toBe('medium');
    expect(replanRiskForTrigger('DEVICE_OFFLINE')).toBe('medium');
    expect(replanRiskForTrigger('RESERVATION_CONFLICT')).toBe('low');
    expect(replanRiskForTrigger(undefined)).toBe('low');
  });

  it('幂等确定性 + 缺口显式（无租户/缺判定事实/非法影响数，§33 不伪造）', () => {
    const input = {
      planId: 'RUN-2B', runId: 'RUN-2', triggerType: 'MANUAL',
      triggerEntityId: null, affectedCount: 0, orgId: 'ORG-1', now: NOW,
    };
    const a = projectReplanDecision(input);
    expect(a.issues).toEqual([]);
    expect(a.record?.riskLevel).toBe('low');
    expect(a.record?.evidence).toEqual(['run:RUN-2', 'trigger:MANUAL', 'affected:0']);
    expect(projectReplanDecision(input).record).toEqual(a.record);

    expect(projectReplanDecision({ ...input, orgId: ' ' }))
      .toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    expect(projectReplanDecision({ ...input, planId: '' }))
      .toEqual({ record: null, issues: ['decision_no_subject_facts'] });
    expect(projectReplanDecision({ ...input, affectedCount: -1 }))
      .toEqual({ record: null, issues: ['decision_invalid_affected_count'] });
  });
});

describe('projectLearningProposalActivationDecision（NO-13n / ADR-063：Decision Catalog kind #7）', () => {
  const NOW = new Date('2026-08-16T15:00:00Z');

  it('approve：契约门通过 + 判定事实完整（approved/human/approver/medium 类型推导/evidence）', () => {
    const { record, issues } = projectLearningProposalActivationDecision({
      proposalId: 'lp:p1',
      kind: 'rule_threshold',
      outcome: 'approved',
      by: 'u1',
      orgId: 'ORG-1',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:lp:p1:activation');
    expect(record?.kind).toBe('learning_proposal_activation');
    expect(record?.status).toBe('approved');
    expect(record?.decisionAuthority).toBe('human');
    expect(record?.subject).toBe('proposal:lp:p1');
    expect(record?.riskLevel).toBe('medium'); // 类型推导规则（阈值激活间接触发调度建议面）
    expect(record?.requiresApproval).toBe(false);
    expect(record?.options).toEqual([
      { optionId: 'opt:activate', reasons: ['kind:rule_threshold'] },
      { optionId: 'opt:keep', reasons: [] },
    ]);
    expect(record?.selected).toEqual({ optionId: 'opt:activate', reason: ['approved'] });
    expect(record?.approver).toEqual({ actor: 'user:u1', at: '2026-08-16T15:00:00.000Z' });
    expect(record?.evidence).toEqual(['proposal:lp:p1', 'kind:rule_threshold']);
    expect(record?.auditTrail).toEqual([
      { actor: 'user:u1', action: 'approved', at: '2026-08-16T15:00:00.000Z' },
    ]);
  });

  it('reject/rollback：理由强制 + 状态映射（rejected / superseded）+ selected=opt:keep', () => {
    const rejected = projectLearningProposalActivationDecision({
      proposalId: 'lp:p2', kind: 'rule_threshold', outcome: 'rejected',
      by: 'u2', reason: '证据不足', orgId: 'ORG-1', now: NOW,
    });
    expect(rejected.issues).toEqual([]);
    expect(rejected.record?.status).toBe('rejected');
    expect(rejected.record?.selected).toEqual({ optionId: 'opt:keep', reason: ['证据不足'] });
    expect(validateDecision(rejected.record)).toEqual([]);

    const rolledBack = projectLearningProposalActivationDecision({
      proposalId: 'lp:p2', kind: 'rule_threshold', outcome: 'rolled_back',
      by: 'u2', reason: '误伤过频', orgId: 'ORG-1', now: NOW,
    });
    expect(rolledBack.issues).toEqual([]);
    expect(rolledBack.record?.status).toBe('superseded');
    expect(rolledBack.record?.selected).toEqual({ optionId: 'opt:keep', reason: ['误伤过频'] });
    expect(rolledBack.record?.auditTrail?.[0].action).toBe('rolled_back');
    expect(validateDecision(rolledBack.record)).toEqual([]);
  });

  it('幂等确定性 + 缺口显式（无租户/缺 proposalId/缺 operator/非批准缺理由，§33 不伪造）', () => {
    const input = {
      proposalId: 'lp:p3', kind: 'rule_threshold', outcome: 'approved' as const,
      by: 'u3', orgId: 'ORG-1', now: NOW,
    };
    const a = projectLearningProposalActivationDecision(input);
    expect(a.issues).toEqual([]);
    expect(projectLearningProposalActivationDecision(input).record).toEqual(a.record);

    expect(projectLearningProposalActivationDecision({ ...input, orgId: ' ' }))
      .toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    expect(projectLearningProposalActivationDecision({ ...input, proposalId: '' }))
      .toEqual({ record: null, issues: ['decision_no_subject_facts'] });
    expect(projectLearningProposalActivationDecision({ ...input, by: '  ' }))
      .toEqual({ record: null, issues: ['decision_no_operator'] });
    expect(projectLearningProposalActivationDecision({ ...input, outcome: 'rejected', reason: undefined }))
      .toEqual({ record: null, issues: ['decision_no_reason'] });
  });
});

describe('projectPolicyActivationDecision（NO-13o / ADR-064：Decision Catalog kind #8）', () => {
  const NOW = new Date('2026-08-16T16:00:00Z');

  it('判定事实完整：executed/human/approver/high 类型推导/evidence（契约门通过）', () => {
    const { record, issues } = projectPolicyActivationDecision({
      configVersion: 3,
      orgId: 'ORG-1',
      approver: 'op1',
      reason: '人工审批激活',
      now: NOW,
    });
    expect(issues).toEqual([]);
    expect(validateDecision(record)).toEqual([]);
    expect(record?.decisionId).toBe('decision:policy:v3:activation');
    expect(record?.kind).toBe('policy_activation');
    expect(record?.status).toBe('executed');
    expect(record?.decisionAuthority).toBe('human');
    expect(record?.subject).toBe('policy:v3');
    expect(record?.riskLevel).toBe('high'); // 类型推导规则（策略激活直接翻转生产调度行为）
    expect(record?.requiresApproval).toBe(false);
    expect(record?.options).toEqual([
      { optionId: 'opt:activate', reasons: ['version:3'] },
      { optionId: 'opt:keep', reasons: [] },
    ]);
    expect(record?.selected).toEqual({ optionId: 'opt:activate', reason: ['人工审批激活'] });
    expect(record?.approver).toEqual({ actor: 'user:op1', at: '2026-08-16T16:00:00.000Z' });
    expect(record?.evidence).toEqual(['version:3']);
    expect(record?.auditTrail).toEqual([
      { actor: 'user:op1', action: 'activated', at: '2026-08-16T16:00:00.000Z' },
    ]);
  });

  it('reason 缺省 activated（savePolicy 直接激活路径）+ 幂等确定性', () => {
    const input = {
      configVersion: 5, orgId: 'ORG-1', approver: 'op2', now: NOW,
    };
    const { record, issues } = projectPolicyActivationDecision(input);
    expect(issues).toEqual([]);
    expect(record?.selected).toEqual({ optionId: 'opt:activate', reason: ['activated'] });
    expect(projectPolicyActivationDecision(input).record).toEqual(record);
  });

  it('缺口显式（§33 不伪造）：无租户（全局策略边界）/ 非法版本 / 缺 approver', () => {
    expect(projectPolicyActivationDecision({
      configVersion: 3, orgId: null, approver: 'op1', now: NOW,
    })).toEqual({ record: null, issues: ['decision_tenant_unknown'] });
    expect(projectPolicyActivationDecision({
      configVersion: 0, orgId: 'ORG-1', approver: 'op1', now: NOW,
    })).toEqual({ record: null, issues: ['decision_invalid_policy_version'] });
    expect(projectPolicyActivationDecision({
      configVersion: 3, orgId: 'ORG-1', approver: '  ', now: NOW,
    })).toEqual({ record: null, issues: ['decision_no_operator'] });
  });
});
