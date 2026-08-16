/* 前后端共享契约 - Canonical Learning Proposal（ADR-026 / NO-12b，§10 Level 7 + §12）。
 *
 * 权威契约：contracts/learning/learning-proposal.schema.json +
 * learning-proposal.test-vectors.json。
 * 语义与 src/edge_platform/contracts/learning_proposal.py 逐项一致
 * （Golden #20 共享向量 + 门禁独立 JS 仲裁约束）。
 */

export const LEARNING_PROPOSAL_KINDS = ['rule_threshold'] as const;
export const LEARNING_PROPOSAL_STATUSES = [
  'proposed', 'shadow_evaluated', 'approved', 'rolled_back', 'rejected',
] as const;

export const THRESHOLD_RULES: ReadonlyArray<readonly [string, string]> = [
  ['rule:worker-overload', 'workloadThreshold'],
];

// worker-overload 触发条件的固定常量（与 reasoning-trace 引擎一致）。
const FATIGUE_BOUND = 0.7;
const ERGONOMIC_BOUND = 0.7;

const KIND_SET: ReadonlySet<string> = new Set(LEARNING_PROPOSAL_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(LEARNING_PROPOSAL_STATUSES);
const THRESHOLD_SET: ReadonlySet<string> = new Set(THRESHOLD_RULES.map(([r, p]) => `${r}\u0000${p}`));

const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  proposed: ['shadow_evaluated', 'rejected'],
  shadow_evaluated: ['approved', 'rejected'],
  approved: ['rolled_back'],
  rolled_back: [],
  rejected: [],
};

export interface ThresholdChange {
  ruleId: string;
  parameter: string;
  baselineValue: number;
  candidateValue: number;
}

export interface ShadowEval {
  baselineThreshold: number;
  candidateThreshold: number;
  factsCount: number;
  baselineFires: number;
  candidateFires: number;
  addedSubjects: string[];
  removedSubjects: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface LearningProposalRecord {
  proposalId: string;
  kind: string;
  status: string;
  change: ThresholdChange;
  shadowEval?: ShadowEval;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedReason?: string;
  rolledBackBy?: string;
  rolledBackReason?: string;
  evaluationRef?: { evalId: string };
  auditTrail: boolean;
}

const REQUIRED_FIELDS = ['proposalId', 'kind', 'status', 'change', 'auditTrail'] as const;
const CHANGE_FIELDS = ['ruleId', 'parameter', 'baselineValue', 'candidateValue'] as const;

function isIso(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function validShadow(shadow: unknown): shadow is ShadowEval {
  if (shadow == null || typeof shadow !== 'object' || Array.isArray(shadow)) return false;
  const s = shadow as Record<string, unknown>;
  for (const field of ['baselineThreshold', 'candidateThreshold', 'factsCount', 'baselineFires', 'candidateFires']) {
    if (!(field in s)) return false;
  }
  if (!isNumber(s.baselineThreshold) || !isNumber(s.candidateThreshold)) return false;
  for (const field of ['factsCount', 'baselineFires', 'candidateFires']) {
    const v = s[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return false;
  }
  for (const field of ['addedSubjects', 'removedSubjects']) {
    const list = s[field];
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || x === '')) return false;
  }
  if (s.riskLevel !== 'low' && s.riskLevel !== 'medium' && s.riskLevel !== 'high') return false;
  return true;
}

/** 校验学习提案记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateLearningProposal(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.proposalId !== 'string' || r.proposalId.trim() === '') return ['bad_proposal_id'];
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  const change = r.change;
  if (change == null || typeof change !== 'object' || Array.isArray(change)) return ['bad_change'];
  const c = change as Record<string, unknown>;
  for (const field of CHANGE_FIELDS) {
    if (!(field in c)) return [`missing_field:${field}`];
  }
  if (!THRESHOLD_SET.has(`${String(c.ruleId)}\u0000${String(c.parameter)}`)) {
    return ['unsupported_threshold'];
  }
  if (!isNumber(c.baselineValue) || !isNumber(c.candidateValue)) return ['bad_change'];
  if (c.baselineValue < 0 || c.baselineValue > 1 || c.candidateValue < 0 || c.candidateValue > 1) {
    return ['bad_change'];
  }
  if (c.baselineValue === c.candidateValue) return ['no_op_change'];
  const status = String(r.status);
  if (status === 'shadow_evaluated' || status === 'approved' || status === 'rolled_back') {
    if (!validShadow(r.shadowEval)) return ['shadow_eval_required'];
  }
  if (status === 'approved') {
    if (typeof r.approvedBy !== 'string' || r.approvedBy.trim() === '') return ['approver_required'];
    if (!isIso(r.approvedAt)) return ['approval_time_required'];
  }
  if (status === 'rejected') {
    if (typeof r.rejectedBy !== 'string' || r.rejectedBy.trim() === '') return ['rejecter_required'];
    if (typeof r.rejectedReason !== 'string' || r.rejectedReason.trim() === '') return ['reject_reason_required'];
  }
  if (status === 'rolled_back') {
    if (typeof r.rolledBackBy !== 'string' || r.rolledBackBy.trim() === '') return ['rollback_by_required'];
    if (typeof r.rolledBackReason !== 'string' || r.rolledBackReason.trim() === '') return ['rollback_reason_required'];
  }
  const evalRef = r.evaluationRef;
  if (evalRef !== undefined) {
    if (evalRef == null || typeof evalRef !== 'object' || Array.isArray(evalRef)
      || typeof (evalRef as Record<string, unknown>).evalId !== 'string') {
      return ['bad_evaluation_ref'];
    }
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}

/** ADR-026 状态机（与 Python 端一致）。 */
export function proposalTransitionAllowed(fromStatus: string, toStatus: string): boolean {
  return (TRANSITIONS[fromStatus] ?? []).includes(toStatus);
}

// ---------------------------------------------------------------------------
// 确定性影子评估器（ADR-026 决策 2；Golden #20 + 门禁独立 JS 仲裁）。
// ---------------------------------------------------------------------------

export interface ShadowFact {
  subjectId: string;
  kind: string;
  values: { workload: number; fatigue: number; ergonomicRisk: number };
}

export interface ShadowResult extends Omit<ShadowEval, 'riskLevel'> {
  riskLevel: 'low' | 'medium' | 'high';
}

/** 历史重放影子评估：worker-overload 在基线/候选阈值下的触发差集。 */
export function evaluateRuleThresholdShadow(
  ruleId: string,
  baselineThreshold: number,
  candidateThreshold: number,
  facts: unknown[],
): ShadowResult {
  if (ruleId !== 'rule:worker-overload') {
    throw new Error(`unsupported_threshold:${ruleId}`);
  }
  if (!isNumber(baselineThreshold) || !isNumber(candidateThreshold)) {
    throw new Error('阈值必须是数值');
  }
  if (baselineThreshold < 0 || baselineThreshold > 1 || candidateThreshold < 0 || candidateThreshold > 1) {
    throw new Error('阈值必须 ∈ [0,1]');
  }
  if (baselineThreshold === candidateThreshold) {
    throw new Error('基线阈值与候选阈值必须不同');
  }
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error('facts 必须是非空列表');
  }
  const normalized = facts.map((fact) => {
    if (fact == null || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new Error('fact 必须是对象');
    }
    const f = fact as Record<string, unknown>;
    const { subjectId, kind, values } = f;
    if (typeof subjectId !== 'string' || subjectId === '') {
      throw new Error('fact.subjectId 必须是非空字符串');
    }
    if (kind !== 'person') {
      throw new Error(`unsupported_fact_kind:${String(kind)}（worker-overload 仅评估 person 事实）`);
    }
    if (values == null || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('fact.values 必须是对象');
    }
    const v = values as Record<string, unknown>;
    const { workload, fatigue, ergonomicRisk } = v;
    if (!isNumber(workload) || !isNumber(fatigue) || !isNumber(ergonomicRisk)) {
      throw new Error('fact.values 必须含数值 workload/fatigue/ergonomicRisk');
    }
    return { subjectId, workload, fatigue, ergonomicRisk };
  });
  const fires = (threshold: number): Set<string> =>
    new Set(
      normalized
        .filter(
          (f) => f.workload >= threshold
            && (f.fatigue >= FATIGUE_BOUND || f.ergonomicRisk >= ERGONOMIC_BOUND),
        )
        .map((f) => f.subjectId),
    );
  const baseline = fires(baselineThreshold);
  const candidate = fires(candidateThreshold);
  const added = [...candidate].filter((s) => !baseline.has(s)).sort();
  const removed = [...baseline].filter((s) => !candidate.has(s)).sort();
  let riskLevel: 'low' | 'medium' | 'high';
  if (removed.length > 0 && candidateThreshold - baselineThreshold >= 0.15) {
    riskLevel = 'high';
  } else if (removed.length > 0) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }
  return {
    baselineThreshold,
    candidateThreshold,
    factsCount: normalized.length,
    baselineFires: baseline.size,
    candidateFires: candidate.size,
    addedSubjects: added,
    removedSubjects: removed,
    riskLevel,
  };
}
