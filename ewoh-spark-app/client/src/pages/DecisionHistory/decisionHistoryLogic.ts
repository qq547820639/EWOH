/* decisionHistoryLogic.ts — 决策历史控制台纯逻辑（NO-13q / ADR-066，§18/§33）。
 *
 * 契约字段 → 行模型：kind/status/authority 标签、风险档 tone、判定事实
 * （selected.reason / approver / evidence / sources）透出；未知词表值原样
 * 透出不猜测标签（§33 不把 unknown 当 normal——展示层不做二次解释）。
 */
import type { DecisionRecord } from '@shared/decision';

export const DECISION_KIND_LABELS: Record<string, string> = {
  task_assignment: '任务分配',
  plan_approval: '方案审批',
  agent_approval: 'Agent 审批',
  resource_reservation: '资源预占',
  dispatch: '派工',
  replan: '重排',
  learning_proposal_activation: '学习提案激活',
  policy_activation: '策略激活',
};

export const DECISION_STATUS_LABELS: Record<string, string> = {
  proposed: '提议',
  approved: '批准',
  rejected: '拒绝',
  executed: '已执行',
  superseded: '已取代',
};

export const DECISION_AUTHORITY_LABELS: Record<string, string> = {
  policy: '政策',
  optimization: '优化器',
  rule_based: '规则',
  human: '人工',
  agent: 'Agent',
};

export type RiskTone = 'high' | 'medium' | 'low' | 'unknown';

/** 可见性修复（2026-08-19 审计 D13，P1 lint 收口）：风险档文字用 risk-*
 * 语义 token（暗色自动提亮，浅色/深色两主题可读）；unknown 用主题 token。 */
export const RISK_TONE_TEXT: Record<RiskTone, string> = {
  high: 'text-risk-blocked',
  medium: 'text-risk-degraded',
  low: 'text-risk-normal',
  unknown: 'text-muted-foreground',
};

export interface DecisionHistoryRow {
  decisionId: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  authority: string;
  authorityLabel: string;
  riskLevel: string;
  riskTone: RiskTone;
  subject: string;
  decidedAt: string;
  selectedReason: string;
  approver: string | null;
  evidence: string[];
}

function riskToneOf(riskLevel: string): RiskTone {
  if (riskLevel === 'high' || riskLevel === 'medium' || riskLevel === 'low') return riskLevel;
  return 'unknown';
}

/** 契约字段 → 行模型（未知词表值原样透出；selected.reason 取首条）。 */
export function buildDecisionRows(items: DecisionRecord[]): DecisionHistoryRow[] {
  return items.map((record) => ({
    decisionId: record.decisionId,
    kind: record.kind,
    kindLabel: DECISION_KIND_LABELS[record.kind] ?? record.kind,
    status: record.status,
    statusLabel: DECISION_STATUS_LABELS[record.status] ?? record.status,
    authority: record.decisionAuthority,
    authorityLabel: DECISION_AUTHORITY_LABELS[record.decisionAuthority] ?? record.decisionAuthority,
    riskLevel: record.riskLevel,
    riskTone: riskToneOf(record.riskLevel),
    subject: record.subject,
    decidedAt: record.decidedAt,
    selectedReason: record.selected?.reason?.[0] ?? '',
    approver: record.approver?.actor ?? null,
    evidence: record.evidence ?? [],
  }));
}

/** 来源计数 → 展示文案（显式可审计）。 */
export function buildSourcesSummary(sources: {
  plans: number;
  agentApprovals: number;
  learningProposals: number;
  policies: number;
}): string {
  return `方案 ${sources.plans} / Agent 审批 ${sources.agentApprovals} / 学习提案 ${sources.learningProposals} / 策略 ${sources.policies}`;
}
