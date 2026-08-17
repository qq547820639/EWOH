/* Canonical Decision Model（ADR-047 / §2/§3/§18，NO-12x）。
 *
 * 权威契约：contracts/decision/decision.schema.json +
 * decision.test-vectors.json。
 * 语义与 src/edge_platform/contracts/decision.py 逐项一致
 * （audit-domain-contracts decision 域跨语言仲裁 + Golden 第 24 场景）。
 * riskLevel 复用 risk 契约 RISK_SEVERITY_LADDER（§31 单一事实源，
 * 不重复定义）。
 */

import { RISK_SEVERITY_LADDER } from './risk';

export const DECISION_KINDS = [
  'task_assignment',
  'plan_approval',
  'agent_approval',
  'resource_reservation',
  'dispatch',
  'replan',
  'learning_proposal_activation',
  'policy_activation',
] as const;

export const DECISION_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'executed',
  'superseded',
] as const;

export const DECISION_AUTHORITIES = [
  'policy',
  'optimization',
  'rule_based',
  'human',
  'agent',
] as const;

/** §31：风险阶梯单一事实源 = risk 契约（import，不重复定义）。 */
export const DECISION_RISK_LEVELS: readonly string[] = RISK_SEVERITY_LADDER;

const KIND_SET: ReadonlySet<string> = new Set(DECISION_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(DECISION_STATUSES);
const AUTHORITY_SET: ReadonlySet<string> = new Set(DECISION_AUTHORITIES);
const RISK_SET: ReadonlySet<string> = new Set(DECISION_RISK_LEVELS);

const CANONICAL_ACTOR = /^[a-z][a-z0-9_]*:[^\s]+$/;
const DECISION_ID = /^decision:[^\s]+$/;

export interface DecisionOption {
  optionId: string;
  score?: number | null;
  reasons?: string[];
}

export interface DecisionSelection {
  optionId: string;
  reason: string[];
}

export interface DecisionApprover {
  actor: string;
  at: string;
}

export interface DecisionAuditEntry {
  actor: string;
  action: string;
  at: string;
}

/** DecisionRecord 形状（与 contracts/decision/decision.schema.json 一致）。 */
export interface DecisionRecord {
  decisionId: string;
  kind: string;
  status: string;
  decisionAuthority: string;
  subject: string;
  tenantId: string;
  riskLevel: string;
  requiresApproval: boolean;
  decidedAt: string;
  policyVersion?: string;
  solverVersion?: string;
  snapshotRef?: string;
  options?: DecisionOption[];
  selected: DecisionSelection;
  rejectedAlternatives?: Array<{ optionId: string; rejectReasons: string[] }>;
  hardConstraints?: string[];
  weightsSnapshot?: Record<string, number>;
  evidence?: string[];
  approver?: DecisionApprover;
  outcomeRef?: string;
  auditTrail: DecisionAuditEntry[];
}

const REQUIRED_FIELDS = [
  'decisionId',
  'kind',
  'status',
  'decisionAuthority',
  'subject',
  'tenantId',
  'riskLevel',
  'requiresApproval',
  'decidedAt',
  'selected',
  'auditTrail',
] as const;

const OPTIONAL_STRING_ERRORS: Record<string, string> = {
  policyVersion: 'bad_policy_version',
  solverVersion: 'bad_solver_version',
  snapshotRef: 'bad_snapshot_ref',
  outcomeRef: 'bad_outcome_ref',
} as const;

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

// SH-008：原命名 isNonEmptyStringList 名实不符（空数组 every() 恒 true）。
// 裁决取「重命名」而非加 length>0：Python decision.py 对 reasons/
// hardConstraints/evidence 均允许空列表（仅逐项非空串），加长度校验会
// 引入新的 TS↔Python 漂移并破坏共享向量，故正名为 isStringList。
function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/** DecisionRecord 契约校验（fail-closed）；返回错误码列表（空=合法）。 */
export function validateDecision(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.decisionId !== 'string' || !DECISION_ID.test(r.decisionId)) {
    return ['bad_decision_id'];
  }
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (!AUTHORITY_SET.has(String(r.decisionAuthority))) return ['unknown_authority'];
  const subject = r.subject;
  if (typeof subject !== 'string' || !CANONICAL_ACTOR.test(subject)) return ['bad_subject'];
  if (typeof r.tenantId !== 'string' || r.tenantId.trim() === '') return ['bad_tenant'];
  if (!RISK_SET.has(String(r.riskLevel))) return ['unknown_risk_level'];
  if (typeof r.requiresApproval !== 'boolean') return ['bad_approval_flag'];
  const decidedAt = r.decidedAt;
  const decidedMs = isoMs(decidedAt);
  if (decidedMs === null) return ['bad_decided_at'];
  for (const [field, errorCode] of Object.entries(OPTIONAL_STRING_ERRORS)) {
    const value = r[field];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      return [errorCode];
    }
  }

  const options = r.options;
  const optionIds: string[] = [];
  if (options !== undefined) {
    if (!Array.isArray(options)) return ['bad_options'];
    for (const option of options) {
      if (option == null || typeof option !== 'object' || Array.isArray(option)) return ['bad_options'];
      const opt = option as Record<string, unknown>;
      const optionId = opt.optionId;
      if (typeof optionId !== 'string' || optionId.trim() === '') return ['bad_option_id'];
      if (optionIds.includes(optionId)) return ['duplicate_option'];
      optionIds.push(optionId);
      if (opt.score !== undefined && opt.score !== null && !isFiniteNumber(opt.score)) {
        return ['bad_options'];
      }
      const reasons = opt.reasons ?? [];
      if (!isStringList(reasons)) return ['bad_options'];
    }
  }

  const selected = r.selected;
  if (selected == null || typeof selected !== 'object' || Array.isArray(selected)) {
    return ['bad_selected'];
  }
  const sel = selected as Record<string, unknown>;
  const selectedId = sel.optionId;
  if (typeof selectedId !== 'string' || selectedId.trim() === '') return ['bad_option_id'];
  const selectedReason = sel.reason;
  if (!Array.isArray(selectedReason) || selectedReason.length === 0
      || selectedReason.some((x) => typeof x !== 'string' || x.trim() === '')) {
    return ['selected_reason_required'];
  }
  if (options !== undefined && !optionIds.includes(selectedId)) {
    return ['unknown_selected_option'];
  }

  const rejected = r.rejectedAlternatives;
  if (rejected !== undefined) {
    if (!Array.isArray(rejected)) return ['bad_rejected'];
    for (const entry of rejected) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return ['bad_rejected'];
      const rej = entry as Record<string, unknown>;
      if (typeof rej.optionId !== 'string' || rej.optionId.trim() === '') return ['bad_option_id'];
      const rejectReasons = rej.rejectReasons;
      if (!Array.isArray(rejectReasons) || rejectReasons.length === 0
          || rejectReasons.some((x) => typeof x !== 'string' || x.trim() === '')) {
        return ['reject_reason_required'];
      }
    }
  }

  if (r.hardConstraints !== undefined && !isStringList(r.hardConstraints)) {
    return ['bad_hard_constraints'];
  }
  const weights = r.weightsSnapshot;
  if (weights !== undefined) {
    if (weights == null || typeof weights !== 'object' || Array.isArray(weights)) return ['bad_weights'];
    for (const value of Object.values(weights)) {
      if (!isFiniteNumber(value)) return ['bad_weights'];
    }
  }
  if (r.evidence !== undefined && !isStringList(r.evidence)) return ['bad_evidence'];

  // 审批判定事实：human 决策或 approved/rejected 状态必带 approver。
  const approver = r.approver;
  const needsApprover = r.decisionAuthority === 'human' || r.status === 'approved' || r.status === 'rejected';
  if (needsApprover) {
    if (approver == null || typeof approver !== 'object' || Array.isArray(approver)) {
      return ['approver_required'];
    }
  }
  if (approver !== undefined) {
    if (approver == null || typeof approver !== 'object' || Array.isArray(approver)) return ['bad_approver'];
    const ap = approver as Record<string, unknown>;
    if (typeof ap.actor !== 'string' || !CANONICAL_ACTOR.test(ap.actor)) return ['bad_approver'];
    const approverMs = isoMs(ap.at);
    if (approverMs === null) return ['bad_approver'];
    if (approverMs < decidedMs) return ['time_order_violation'];
  }

  const auditTrail = r.auditTrail;
  if (!Array.isArray(auditTrail) || auditTrail.length === 0) return ['audit_required'];
  for (const entry of auditTrail) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return ['bad_audit_entry'];
    const en = entry as Record<string, unknown>;
    if (typeof en.actor !== 'string' || !CANONICAL_ACTOR.test(en.actor)) return ['bad_audit_entry'];
    if (typeof en.action !== 'string' || en.action.trim() === '') return ['bad_audit_entry'];
    if (isoMs(en.at) === null) return ['bad_audit_entry'];
  }
  return [];
}
