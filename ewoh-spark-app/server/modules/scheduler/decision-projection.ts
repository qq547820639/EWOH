/* decision-projection.ts — Canonical Decision Model 生产投影（ADR-048 / NO-12y，§3/§12/§18）。
 *
 * DecisionTrace（TS 求解内嵌形状）→ DecisionRecord（ADR-047 契约形态）唯一投影点。
 * 语义（ADR-048）：
 *   - kind=task_assignment / status=proposed / decisionAuthority=optimization；
 *   - decisionId = decision:<planId>:<taskId>（确定性幂等）；subject = task:<taskId>；
 *   - riskLevel 映射自真实 route-graph 风险事实（assignment.riskLevel：
 *     high→high / medium→medium / null→low——null = 路径无被标记高/中风险边，
 *     平台风险模型下的低风险档合法读数；映射规则锁测试，§33 非伪造）；
 *   - requiresApproval=true 恒真（task_assignment 提议必经方案审批，§2 人审留痕）；
 *   - options ← candidates（optionId 由 person/device/station 组合确定性推导；
 *     selected 组合不在 options（baseline reuse 快速路径）时以 score=null +
 *     selectedReason 补入——契约不变式 selected∈options，语义不变）；
 *   - selected.reason ← selectedReason 非空过滤（过滤后为空 → 显式缺口跳过）；
 *   - rejectedAlternatives ← rejectedAlternatives + rejectedHard（rejectReasons 非空过滤）；
 *   - auditTrail = solver 决定事实（actor=solver:<solverVersion>，at=decidedAt）；
 *   - 生成记录必过 validateDecision（共享契约实现，§31 单一实现）；失败 →
 *     decision_invalid:<code> 显式缺口（§33 绝不静默丢弃、绝不伪造）。
 */

import type { DecisionTrace, SchedulingPlanV2 } from '@shared/scheduler';
import {
  validateDecision,
  type DecisionRecord,
} from '@shared/decision';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface DecisionProjectionIssue {
  assignmentId: string;
  reason: string;
}

function nonEmptyStrings(values: readonly string[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => typeof v === 'string' && v.trim() !== '');
}

/** person/device/station 组合 → 确定性 optionId（无空格，契约形状合法）。 */
export function comboOptionId(
  personId: string | null,
  deviceId: string | null,
  stationId: string | null,
): string {
  return `opt:${personId ?? 'none'}:${deviceId ?? 'none'}:${stationId ?? 'none'}`;
}

/** ADR-048 决策 2：route-graph 风险事实 → 决策风险阶梯（确定性映射，锁测试）。 */
export function mapRouteRiskToDecisionRisk(riskLevel: string | null): 'high' | 'medium' | 'low' {
  if (riskLevel === 'high') return 'high';
  if (riskLevel === 'medium') return 'medium';
  return 'low';
}

/** 决策记录 riskLevel 必须落在封闭阶梯（防御：调用方传入非阶梯值时显式缺口）。 */
export function isDecisionRiskLevel(value: string): value is 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'medium' || value === 'low';
}

export interface TaskAssignmentProjection {
  record: DecisionRecord | null;
  issues: string[];
}

/** 单个 assignment 的 DecisionTrace → DecisionRecord（含显式缺口；null=未产出）。 */
export function projectTaskAssignmentDecision(
  trace: DecisionTrace,
  assignment: { assignmentId: string; riskLevel: string | null },
  plan: SchedulingPlanV2,
  ctx: OrgContext,
): TaskAssignmentProjection {
  const issues: string[] = [];
  const tenantId = ctx.primaryOrgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (typeof plan.createdAt !== 'string' || plan.createdAt.trim() === '') {
    return { record: null, issues: ['decision_no_decided_at'] };
  }
  if (typeof trace.solverVersion !== 'string' || trace.solverVersion.trim() === '') {
    return { record: null, issues: ['decision_no_solver_version'] };
  }
  const decidedAt = new Date(plan.createdAt).toISOString();
  const riskLevel = mapRouteRiskToDecisionRisk(assignment.riskLevel);
  if (!isDecisionRiskLevel(riskLevel)) {
    return { record: null, issues: ['decision_unknown_risk'] };
  }

  const selectedReason = nonEmptyStrings(trace.selectedReason);
  if (selectedReason.length === 0) {
    return { record: null, issues: ['decision_no_selected_reason'] };
  }

  const selectedOptionId = comboOptionId(
    trace.selected.personId,
    trace.selected.deviceId,
    trace.selected.stationId,
  );

  const options: DecisionRecord['options'] = (trace.candidates ?? []).map((c) => ({
    optionId: comboOptionId(c.personId, c.deviceId, c.stationId),
    score: c.score ?? null,
    reasons: nonEmptyStrings(c.reasons),
  }));
  // baseline reuse 快速路径：selected 组合可能不在 feasibleTopK → 补入（语义不变）。
  if (!options.some((o) => o.optionId === selectedOptionId)) {
    options.push({ optionId: selectedOptionId, score: null, reasons: selectedReason });
  }

  const rejectedAlternatives: NonNullable<DecisionRecord['rejectedAlternatives']> = [];
  for (const alt of trace.rejectedAlternatives ?? []) {
    const rejectReasons = nonEmptyStrings(alt.reason);
    if (rejectReasons.length === 0) continue;
    rejectedAlternatives.push({
      optionId: comboOptionId(alt.personId, alt.deviceId, alt.stationId ?? null),
      rejectReasons,
    });
  }
  for (const hard of trace.rejectedHard ?? []) {
    const rejectReasons = nonEmptyStrings(hard.rejectReasons);
    if (rejectReasons.length === 0) continue;
    rejectedAlternatives.push({
      optionId: comboOptionId(hard.personId, hard.deviceId, hard.stationId),
      rejectReasons,
    });
  }

  const weightsSnapshot: Record<string, number> = {};
  if (trace.weightsSnapshot != null && typeof trace.weightsSnapshot === 'object') {
    for (const [key, value] of Object.entries(trace.weightsSnapshot)) {
      if (typeof value === 'number' && Number.isFinite(value)) weightsSnapshot[key] = value;
    }
  }

  const record: DecisionRecord = {
    decisionId: `decision:${plan.planId}:${trace.taskId}`,
    kind: 'task_assignment',
    status: 'proposed',
    decisionAuthority: 'optimization',
    subject: `task:${trace.taskId}`,
    tenantId,
    riskLevel,
    requiresApproval: true,
    decidedAt,
    options,
    selected: { optionId: selectedOptionId, reason: selectedReason },
    rejectedAlternatives,
    hardConstraints: nonEmptyStrings(trace.hardConstraints),
    weightsSnapshot,
    policyVersion: trace.policyVersion != null ? String(trace.policyVersion) : undefined,
    solverVersion: trace.solverVersion,
    snapshotRef: trace.snapshotVersion?.trim() ? trace.snapshotVersion : undefined,
    auditTrail: [{ actor: `solver:${trace.solverVersion}`, action: 'decided', at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues };
}

export interface PlanDecisionProjection {
  records: DecisionRecord[];
  issues: DecisionProjectionIssue[];
}

/**
 * NO-13h / ADR-057：plan_approval 决策投影（Decision Catalog kind #2）。
 * approve/reject 人审事实 → DecisionRecord（契约门内）：
 *  - decisionId = decision:<planId>:approval:v<version>（确定性幂等）；
 *  - kind=plan_approval；authority=human；approver.actor=user:<operator>
 *    （判定事实完整）；riskLevel='high'（类型推导规则：审批门直通生产
 *    派工——映射规则锁测试，§33 非伪造）；requiresApproval=false
 *    （本决策即审批事实本身）；selected.reason=审批理由（缺省用结果
 *    动作词——事实非伪造）；validateDecision 门：失败显式缺口。
 */
export function projectPlanApprovalDecision(
  planId: string,
  version: number,
  outcome: 'approved' | 'rejected',
  operator: string,
  reason: string | undefined,
  ctx: OrgContext,
  now: Date,
): TaskAssignmentProjection {
  const tenantId = ctx.primaryOrgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (!operator?.trim()) {
    return { record: null, issues: ['decision_no_operator'] };
  }
  const decidedAt = now.toISOString();
  const reasonText = reason?.trim() || (outcome === 'approved' ? 'approved' : 'rejected');
  const record: DecisionRecord = {
    decisionId: `decision:${planId}:approval:v${version}`,
    kind: 'plan_approval',
    status: outcome,
    decisionAuthority: 'human',
    subject: `plan:${planId}`,
    tenantId,
    riskLevel: 'high',
    requiresApproval: false,
    decidedAt,
    options: [
      { optionId: 'opt:approve', reasons: outcome === 'approved' ? [reasonText] : [] },
      { optionId: 'opt:reject', reasons: outcome === 'rejected' ? [reasonText] : [] },
    ],
    selected: { optionId: outcome === 'approved' ? 'opt:approve' : 'opt:reject', reason: [reasonText] },
    approver: { actor: `user:${operator.trim()}`, at: decidedAt },
    auditTrail: [{ actor: `user:${operator.trim()}`, action: outcome, at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}

/** 方案级唯一投影点（persistPlan 调用）：所有 assignment 的 trace → records + 显式缺口。 */
export function projectPlanDecisionRecords(
  plan: SchedulingPlanV2,
  ctx: OrgContext,
): PlanDecisionProjection {
  const records: DecisionRecord[] = [];
  const issues: DecisionProjectionIssue[] = [];
  for (const assignment of plan.assignments) {
    if (!assignment.decisionTrace) {
      issues.push({ assignmentId: assignment.assignmentId, reason: 'decision_no_trace' });
      continue;
    }
    const projected = projectTaskAssignmentDecision(
      assignment.decisionTrace,
      { assignmentId: assignment.assignmentId, riskLevel: assignment.riskLevel ?? null },
      plan,
      ctx,
    );
    if (projected.record) {
      records.push(projected.record);
    }
    for (const reason of projected.issues) {
      issues.push({ assignmentId: assignment.assignmentId, reason });
    }
  }
  return { records, issues };
}

/**
 * NO-13j / ADR-059：agent_approval 决策投影（Decision Catalog kind #3）。
 * Agent 审批解析事实（ewoh_agent_approval 台账，ADR-039 唯一权威源）→
 * DecisionRecord（契约门内）：
 *  - decisionId = decision:<approvalId>:agent-approval（确定性幂等——
 *    ADR-039 CAS 保证同一 approval 单次解析）；
 *  - kind=agent_approval；status=approved/rejected（expired → rejected，
 *    reason=approval_expired）；authority：人工解析=human / TTL 超期=
 *    policy（解析人不存在——事实区分，不伪造 human 身份）；
 *  - subject=agent:<agentId>；riskLevel 映射自 manifest.riskLevel
 *    （真实清单事实，封闭词表；critical 收敛到决策阶梯最高档 high，
 *    evidence 携带 manifest_risk:<level> 原始档不丢信息）；
 *  - requiresApproval=false（本决策即审批事实）；approver 判定事实
 *    （human → user:<userId>；policy → policy:agent-approval-ttl）；
 *  - selected.reason = 解析事实（批准理由缺省 'approved' / 人工驳回 /
 *    approval_expired）；validateDecision 门：失败显式缺口。
 */

/** 清单风险档 → 决策阶梯（ADR-059 决策 1 映射规则，锁测试）。 */
export function mapAgentRiskToDecisionRisk(level: string | null | undefined): 'high' | 'medium' | 'low' | null {
  if (level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return 'high';
  if (level === 'critical') return 'high'; // 清单专属档收敛到决策阶梯最高档（evidence 留原始档）
  return null;
}

export interface AgentApprovalDecisionInput {
  approvalId: string;
  agentId: string;
  command: string;
  orgId: string;
  manifestRiskLevel: string | null | undefined;
  outcome: 'approved' | 'rejected' | 'expired';
  /** 人工解析人（expired 路径可为空——TTL 策略解析）。 */
  operator?: string | null;
  /** 人工理由（缺省用结果动作词/事实短语）。 */
  reason?: string | null;
  now: Date;
}

export function projectAgentApprovalDecision(
  input: AgentApprovalDecisionInput,
): TaskAssignmentProjection {
  const tenantId = input.orgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (!input.approvalId?.trim() || !input.agentId?.trim()) {
    return { record: null, issues: ['decision_no_subject_facts'] };
  }

  const humanResolved = input.outcome !== 'expired';
  const operator = input.operator?.trim();
  if (humanResolved && !operator) {
    // 人工解析缺操作者 = 判定事实缺失（§33 不伪造 human 身份）。
    return { record: null, issues: ['decision_no_operator'] };
  }

  const riskLevel = mapAgentRiskToDecisionRisk(input.manifestRiskLevel);
  if (!riskLevel) {
    return { record: null, issues: ['decision_unknown_risk'] };
  }

  const decidedAt = input.now.toISOString();
  const status = input.outcome === 'approved' ? 'approved' : 'rejected';
  const reasonText =
    input.reason?.trim() ||
    (input.outcome === 'approved' ? 'approved' : input.outcome === 'rejected' ? '人工驳回' : 'approval_expired');
  const actor = humanResolved ? `user:${operator}` : 'policy:agent-approval-ttl';
  const action = input.outcome;

  const record: DecisionRecord = {
    decisionId: `decision:${input.approvalId}:agent-approval`,
    kind: 'agent_approval',
    status,
    decisionAuthority: humanResolved ? 'human' : 'policy',
    subject: `agent:${input.agentId}`,
    tenantId,
    riskLevel,
    requiresApproval: false,
    decidedAt,
    options: [
      { optionId: 'opt:approve', reasons: input.outcome === 'approved' ? [reasonText] : [] },
      { optionId: 'opt:reject', reasons: input.outcome !== 'approved' ? [reasonText] : [] },
    ],
    selected: {
      optionId: input.outcome === 'approved' ? 'opt:approve' : 'opt:reject',
      reason: [reasonText],
    },
    approver: { actor, at: decidedAt },
    evidence: [
      input.manifestRiskLevel ? `manifest_risk:${input.manifestRiskLevel}` : 'manifest_risk:unknown',
      `command:${input.command}`,
    ],
    auditTrail: [{ actor, action, at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}

/**
 * NO-13k / ADR-060：resource_reservation 决策投影（Decision Catalog kind #4）。
 * 派工链预占事实（ewoh_resource_reservation 台账行——reserve() 返回值，
 * 唯一权威源）→ DecisionRecord（契约门内）：
 *  - decisionId = decision:<planId>:reservation:<assignmentId>:<reservationId>
 *    （确定性幂等——reservationId 单次生成 + double-dispatch CAS）；
 *  - kind=resource_reservation；status=executed（预占已实际完成——
 *    执行步骤留痕非提议）；authority=rule_based（预占输入由
 *    assignment 字段确定性推导）；
 *  - subject=resource:<resourceType>:<resourceId>；riskLevel 复用
 *    ADR-048 决策 2 映射规则（同一分配的风险读数，§31 单一规则）；
 *  - requiresApproval=false（审批事实在 kind #2 plan_approval）；
 *  - selected.reason = `${reservationId}:${resourceType}:${resourceId}:
 *    ${startMs}-${endMs}`（台账行唯一链接，可追溯）；
 *  - auditTrail actor = user:<operator> | system:dispatch；
 *  - validateDecision 门：失败显式缺口。
 */
export interface ResourceReservationDecisionInput {
  planId: string;
  assignmentId: string;
  taskId: string | null;
  reservation: {
    reservationId: string;
    resourceType: string;
    resourceId: string;
    startMs: number;
    endMs: number;
  };
  /** SchedulingAssignment.riskLevel（ADR-048 决策 2 同源映射）。 */
  assignmentRiskLevel: string | null;
  orgId: string;
  operator?: string | null;
  now: Date;
}

export function projectResourceReservationDecision(
  input: ResourceReservationDecisionInput,
): TaskAssignmentProjection {
  const tenantId = input.orgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  const reservationId = input.reservation?.reservationId?.trim();
  if (!input.planId?.trim() || !input.assignmentId?.trim() || !reservationId) {
    return { record: null, issues: ['decision_no_subject_facts'] };
  }

  const riskLevel = mapRouteRiskToDecisionRisk(input.assignmentRiskLevel);
  if (!isDecisionRiskLevel(riskLevel)) {
    return { record: null, issues: ['decision_unknown_risk'] };
  }

  const decidedAt = input.now.toISOString();
  const { resourceType, resourceId, startMs, endMs } = input.reservation;
  const windowText = `${startMs}-${endMs}`;
  const selectedReason = `${reservationId}:${resourceType}:${resourceId}:${windowText}`;
  const actor = input.operator?.trim() ? `user:${input.operator.trim()}` : 'system:dispatch';
  const evidence = [`assignment:${input.assignmentId}`];
  if (input.taskId?.trim()) evidence.push(`task:${input.taskId}`);

  const record: DecisionRecord = {
    decisionId: `decision:${input.planId}:reservation:${input.assignmentId}:${reservationId}`,
    kind: 'resource_reservation',
    status: 'executed',
    decisionAuthority: 'rule_based',
    subject: `resource:${resourceType}:${resourceId}`,
    tenantId,
    riskLevel,
    requiresApproval: false,
    decidedAt,
    options: [
      { optionId: 'opt:reserve', reasons: [windowText] },
      { optionId: 'opt:skip', reasons: [] },
    ],
    selected: { optionId: 'opt:reserve', reason: [selectedReason] },
    evidence,
    auditTrail: [{ actor, action: 'reserved', at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}

/**
 * NO-13l / ADR-061：dispatch 决策投影（Decision Catalog kind #5）。
 * 派工链完成事实（DispatchCoordinator 同事务内 assignmentCount/
 * outboxEventIds）→ DecisionRecord（契约门内）：
 *  - decisionId = decision:<planId>:dispatch（确定性幂等——
 *    double-dispatch CAS 保证同一方案至多派工一次）；
 *  - kind=dispatch；status=executed；authority=policy（派工链含
 *    政策门 SAFETY_BLOCK_DISPATCH / ADVISORY fail-closed /
 *    快照新鲜度强校验）；
 *  - subject=plan:<planId>；riskLevel=分配风险档聚合（max 规则：
 *    任一 high→high，否则任一 medium→medium，否则 low——复用
 *    ADR-048 决策 2 单条映射，聚合规则锁测试）；
 *  - requiresApproval=false（审批事实在 kind #2）；
 *  - selected.reason=dispatched:<count>（真实派工数）；evidence
 *    携带 outbox 事件 id 链接 + assignments:<count>；
 *  - auditTrail actor = user:<operator> | system:dispatch；
 *  - validateDecision 门：失败显式缺口。
 */

/** ADR-061 决策 1：分配风险档聚合（max 规则，锁测试）。 */
export function maxDecisionRisk(levels: Array<string | null>): 'high' | 'medium' | 'low' {
  let best: 'low' | 'medium' = 'low';
  for (const level of levels) {
    const mapped = mapRouteRiskToDecisionRisk(level);
    if (mapped === 'high') return 'high';
    if (mapped === 'medium') best = 'medium';
  }
  return best;
}

export interface DispatchDecisionInput {
  planId: string;
  assignmentRiskLevels: Array<string | null>;
  dispatchCount: number;
  outboxEventIds: string[];
  orgId: string;
  operator?: string | null;
  now: Date;
}

export function projectDispatchDecision(
  input: DispatchDecisionInput,
): TaskAssignmentProjection {
  const tenantId = input.orgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (!input.planId?.trim()) {
    return { record: null, issues: ['decision_no_subject_facts'] };
  }
  if (!Number.isFinite(input.dispatchCount) || input.dispatchCount < 0) {
    return { record: null, issues: ['decision_invalid_dispatch_count'] };
  }

  const decidedAt = input.now.toISOString();
  const riskLevel = maxDecisionRisk(input.assignmentRiskLevels);
  const actor = input.operator?.trim() ? `user:${input.operator.trim()}` : 'system:dispatch';
  const evidence = [`assignments:${input.dispatchCount}`];
  for (const eventId of input.outboxEventIds ?? []) {
    if (typeof eventId === 'string' && eventId.trim() !== '') {
      evidence.push(`outbox:${eventId}`);
    }
  }

  const record: DecisionRecord = {
    decisionId: `decision:${input.planId}:dispatch`,
    kind: 'dispatch',
    status: 'executed',
    decisionAuthority: 'policy',
    subject: `plan:${input.planId}`,
    tenantId,
    riskLevel,
    requiresApproval: false,
    decidedAt,
    options: [
      { optionId: 'opt:dispatch', reasons: [`assignments:${input.dispatchCount}`] },
      { optionId: 'opt:hold', reasons: [] },
    ],
    selected: { optionId: 'opt:dispatch', reason: [`dispatched:${input.dispatchCount}`] },
    evidence,
    auditTrail: [{ actor, action: 'dispatched', at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}

/**
 * NO-13m / ADR-062：replan 决策投影（Decision Catalog kind #6）。
 * 动态重排事实（ReplanCoordinator 真实动作：run/trigger/affected/
 * 新方案 planId）→ DecisionRecord（契约门内）：
 *  - decisionId = decision:<planId>:replan（确定性幂等——同一
 *    planId 至多持久化一次）；
 *  - kind=replan；status=proposed（新方案 shadow 待审批）；
 *  - authority=policy（触发链=政策驱动：debounce/storm/影响分析/
 *    suppress 门）；subject=plan:<planId>；
 *  - riskLevel=触发类型推导规则（锁测试）：SAFETY_EVENT /
 *    ZONE_RESTRICTED → high；PERSON_UNAVAILABLE / DEVICE_OFFLINE →
 *    medium；其余 → low（触发类型是真实事实，规则显式声明）；
 *  - requiresApproval=true（重排产出 shadow 方案必经审批）；
 *  - selected.reason=trigger:<type>:affected:<n>；evidence 携带
 *    run/trigger/affected/entity 链接；
 *  - auditTrail actor=policy:replan-trigger（自动触发，不伪造
 *    human 身份）；validateDecision 门：失败显式缺口。
 */

/** ADR-062 决策 1：触发类型 → 决策风险档（类型推导规则，锁测试）。 */
export function replanRiskForTrigger(triggerType: string | null | undefined): 'high' | 'medium' | 'low' {
  if (triggerType === 'SAFETY_EVENT' || triggerType === 'ZONE_RESTRICTED') return 'high';
  if (triggerType === 'PERSON_UNAVAILABLE' || triggerType === 'DEVICE_OFFLINE') return 'medium';
  return 'low';
}

export interface ReplanDecisionInput {
  planId: string;
  runId: string;
  triggerType: string;
  triggerEntityId: string | null;
  affectedCount: number;
  orgId: string;
  now: Date;
}

export function projectReplanDecision(
  input: ReplanDecisionInput,
): TaskAssignmentProjection {
  const tenantId = input.orgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (!input.planId?.trim() || !input.runId?.trim() || !input.triggerType?.trim()) {
    return { record: null, issues: ['decision_no_subject_facts'] };
  }
  if (!Number.isFinite(input.affectedCount) || input.affectedCount < 0) {
    return { record: null, issues: ['decision_invalid_affected_count'] };
  }

  const decidedAt = input.now.toISOString();
  const riskLevel = replanRiskForTrigger(input.triggerType);
  const evidence = [
    `run:${input.runId}`,
    `trigger:${input.triggerType}`,
    `affected:${input.affectedCount}`,
  ];
  if (input.triggerEntityId?.trim()) evidence.push(`entity:${input.triggerEntityId}`);

  const record: DecisionRecord = {
    decisionId: `decision:${input.planId}:replan`,
    kind: 'replan',
    status: 'proposed',
    decisionAuthority: 'policy',
    subject: `plan:${input.planId}`,
    tenantId,
    riskLevel,
    requiresApproval: true,
    decidedAt,
    options: [
      { optionId: 'opt:replan', reasons: [`trigger:${input.triggerType}`] },
      { optionId: 'opt:keep', reasons: [] },
    ],
    selected: {
      optionId: 'opt:replan',
      reason: [`trigger:${input.triggerType}:affected:${input.affectedCount}`],
    },
    evidence,
    auditTrail: [{ actor: 'policy:replan-trigger', action: 'replanned', at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}

/**
 * NO-13n / ADR-063：learning_proposal_activation 决策投影
 * （Decision Catalog kind #7）。学习提案激活/拒绝/回滚人审事实
 * （ADR-026 台账）→ DecisionRecord（契约门内）：
 *  - decisionId = decision:<proposalId>:activation（确定性幂等——
 *    状态机单向转移保证同一提案单次解析）；
 *  - kind=learning_proposal_activation；status：approve→approved /
 *    reject→rejected / rollback→superseded（激活决策被回滚取代）；
 *  - authority=human（三路径均强制人审身份 + 理由）；subject=
 *    proposal:<proposalId>；riskLevel='medium'（类型推导规则锁测试：
 *    阈值激活间接触发调度建议面——规则显式声明非伪造）；
 *  - requiresApproval=false（本决策即人审事实本身）；
 *  - selected：approve→opt:activate（缺省 'approved'）/ reject·
 *    rollback→opt:keep（reason=必填理由事实）；approver 判定事实；
 *  - auditTrail actor=user:<by>；validateDecision 门：失败显式缺口。
 */

export type LearningProposalOutcome = 'approved' | 'rejected' | 'rolled_back';

export interface LearningProposalActivationDecisionInput {
  proposalId: string;
  kind: string;
  outcome: LearningProposalOutcome;
  by: string;
  reason?: string | null;
  orgId: string;
  now: Date;
}

export function projectLearningProposalActivationDecision(
  input: LearningProposalActivationDecisionInput,
): TaskAssignmentProjection {
  const tenantId = input.orgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (!input.proposalId?.trim()) {
    return { record: null, issues: ['decision_no_subject_facts'] };
  }
  const by = input.by?.trim();
  if (!by) {
    return { record: null, issues: ['decision_no_operator'] };
  }

  const decidedAt = input.now.toISOString();
  const status = input.outcome === 'approved'
    ? 'approved'
    : input.outcome === 'rejected'
      ? 'rejected'
      : 'superseded';
  const reasonText =
    input.reason?.trim() ||
    (input.outcome === 'approved' ? 'approved' : undefined);
  if (input.outcome !== 'approved' && !reasonText) {
    // reject/rollback 理由为强制判定事实（服务层已强制，投影防御）。
    return { record: null, issues: ['decision_no_reason'] };
  }
  const selected =
    input.outcome === 'approved'
      ? { optionId: 'opt:activate', reason: [reasonText!] }
      : { optionId: 'opt:keep', reason: [reasonText!] };

  const record: DecisionRecord = {
    decisionId: `decision:${input.proposalId}:activation`,
    kind: 'learning_proposal_activation',
    status,
    decisionAuthority: 'human',
    subject: `proposal:${input.proposalId}`,
    tenantId,
    riskLevel: 'medium',
    requiresApproval: false,
    decidedAt,
    options: [
      { optionId: 'opt:activate', reasons: [`kind:${input.kind}`] },
      { optionId: 'opt:keep', reasons: [] },
    ],
    selected,
    approver: { actor: `user:${by}`, at: decidedAt },
    evidence: [`proposal:${input.proposalId}`, `kind:${input.kind}`],
    auditTrail: [{ actor: `user:${by}`, action: input.outcome, at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}

/**
 * NO-13o / ADR-064：policy_activation 决策投影（Decision Catalog kind #8
 * ——8 类 kind 全收敛收口）。策略版本激活人审事实（ewoh_scheduling_policy
 * 行 active 翻转）→ DecisionRecord（契约门内）：
 *  - decisionId = decision:policy:v<version>:activation（确定性幂等——
 *    decision_json 单记录列，重复激活同 id 覆盖为最新决策，语义显式）；
 *  - kind=policy_activation；status=executed（active 翻转已完成）；
 *  - authority=human（approver 强制人审门）；subject=policy:v<v>；
 *  - riskLevel='high'（类型推导规则锁测试：策略激活直接翻转生产调度行为）；
 *  - requiresApproval=false（本记录即人审激活事实）；approver 判定事实；
 *  - selected.reason=[reason || 'activated']；evidence=version:<v>；
 *  - validateDecision 门：失败显式缺口。
 */

export interface PolicyActivationDecisionInput {
  configVersion: number;
  orgId: string | null;
  approver: string;
  reason?: string | null;
  now: Date;
}

export function projectPolicyActivationDecision(
  input: PolicyActivationDecisionInput,
): TaskAssignmentProjection {
  const tenantId = input.orgId?.trim();
  if (!tenantId) {
    return { record: null, issues: ['decision_tenant_unknown'] };
  }
  if (!Number.isFinite(input.configVersion) || input.configVersion < 1) {
    return { record: null, issues: ['decision_invalid_policy_version'] };
  }
  const approver = input.approver?.trim();
  if (!approver) {
    return { record: null, issues: ['decision_no_operator'] };
  }

  const decidedAt = input.now.toISOString();
  const reasonText = input.reason?.trim() || 'activated';
  const record: DecisionRecord = {
    decisionId: `decision:policy:v${input.configVersion}:activation`,
    kind: 'policy_activation',
    status: 'executed',
    decisionAuthority: 'human',
    subject: `policy:v${input.configVersion}`,
    tenantId,
    riskLevel: 'high',
    requiresApproval: false,
    decidedAt,
    options: [
      { optionId: 'opt:activate', reasons: [`version:${input.configVersion}`] },
      { optionId: 'opt:keep', reasons: [] },
    ],
    selected: { optionId: 'opt:activate', reason: [reasonText] },
    approver: { actor: `user:${approver}`, at: decidedAt },
    evidence: [`version:${input.configVersion}`],
    auditTrail: [{ actor: `user:${approver}`, action: 'activated', at: decidedAt }],
  };
  const errors = validateDecision(record);
  if (errors.length > 0) {
    return { record: null, issues: [`decision_invalid:${errors[0]}`] };
  }
  return { record, issues: [] };
}
