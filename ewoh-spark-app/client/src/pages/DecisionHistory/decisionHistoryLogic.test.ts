/* decisionHistoryLogic.test.ts — 决策历史控制台纯逻辑（NO-13q / ADR-066，§18/§33）。
 *
 * 契约字段 → 行模型：标签映射（已知/未知透出）、风险档 tone、
 * selected.reason 首条、approver/evidence 透出、sources 摘要。
 */
import {
  buildDecisionRows,
  buildSourcesSummary,
  DECISION_KIND_LABELS,
  DECISION_STATUS_LABELS,
  DECISION_AUTHORITY_LABELS,
} from './decisionHistoryLogic';
import type { DecisionRecord } from '@shared/decision';

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: 'decision:d1',
    kind: 'task_assignment',
    status: 'proposed',
    decisionAuthority: 'optimization',
    subject: 'task:t1',
    tenantId: 'ORG-1',
    riskLevel: 'low',
    requiresApproval: true,
    decidedAt: '2026-08-16T10:00:00.000Z',
    selected: { optionId: 'opt:a', reason: ['highest-score'] },
    auditTrail: [{ actor: 'solver:heuristic-v2', action: 'decided', at: '2026-08-16T10:00:00.000Z' }],
    ...overrides,
  };
}

describe('decisionHistoryLogic（NO-13q / ADR-066）', () => {
  it('标签映射：8 类 kind + 5 态 status + 5 类 authority 全部有中文标签', () => {
    expect(Object.keys(DECISION_KIND_LABELS)).toHaveLength(8);
    expect(Object.keys(DECISION_STATUS_LABELS)).toHaveLength(5);
    expect(Object.keys(DECISION_AUTHORITY_LABELS)).toHaveLength(5);
    expect(DECISION_KIND_LABELS.policy_activation).toBe('策略激活');
    expect(DECISION_STATUS_LABELS.superseded).toBe('已取代');
    expect(DECISION_AUTHORITY_LABELS.rule_based).toBe('规则');
  });

  it('buildDecisionRows：契约字段 → 行模型（selected 首条 / approver / evidence / 风险 tone）', () => {
    const rows = buildDecisionRows([
      record({
        decisionId: 'decision:p1',
        kind: 'plan_approval',
        status: 'approved',
        decisionAuthority: 'human',
        riskLevel: 'high',
        selected: { optionId: 'opt:approve', reason: ['人工审批激活'] },
        approver: { actor: 'user:op1', at: '2026-08-16T10:00:00.000Z' },
        evidence: ['version:3'],
      }),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kindLabel).toBe('方案审批');
    expect(row.statusLabel).toBe('批准');
    expect(row.authorityLabel).toBe('人工');
    expect(row.riskTone).toBe('high');
    expect(row.selectedReason).toBe('人工审批激活');
    expect(row.approver).toBe('user:op1');
    expect(row.evidence).toEqual(['version:3']);
  });

  it('未知词表值原样透出（§33 不猜测标签）+ 未知风险档 tone=unknown', () => {
    const rows = buildDecisionRows([
      record({ kind: 'future_kind', status: 'future_status', decisionAuthority: 'future_auth', riskLevel: 'extreme' }),
    ]);
    expect(rows[0].kindLabel).toBe('future_kind');
    expect(rows[0].statusLabel).toBe('future_status');
    expect(rows[0].authorityLabel).toBe('future_auth');
    expect(rows[0].riskTone).toBe('unknown');
  });

  it('buildSourcesSummary：四源计数显式可审计', () => {
    expect(
      buildSourcesSummary({ plans: 2, agentApprovals: 1, learningProposals: 0, policies: 3 }),
    ).toBe('方案 2 / Agent 审批 1 / 学习提案 0 / 策略 3');
  });
});
