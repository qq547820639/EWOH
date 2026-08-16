/* decision.spec.ts — Canonical Decision Model TS 实现（ADR-047 / NO-12x）。
 *
 * 与 contracts/decision/decision.test-vectors.json 共享向量语义
 * （audit-domain-contracts decision 域跨语言仲裁 + Golden 第 24 场景）。
 */
import {
  DECISION_AUTHORITIES,
  DECISION_KINDS,
  DECISION_RISK_LEVELS,
  DECISION_STATUSES,
  validateDecision,
} from './decision';
import { RISK_SEVERITY_LADDER } from './risk';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: 'decision:spec:1',
    kind: 'task_assignment',
    status: 'proposed',
    decisionAuthority: 'optimization',
    subject: 'task:t-1',
    tenantId: 't-org-1',
    riskLevel: 'medium',
    requiresApproval: true,
    decidedAt: '2026-08-16T08:00:00Z',
    options: [
      { optionId: 'opt:a', score: 90, reasons: ['skill-match'] },
      { optionId: 'opt:b', score: 70, reasons: [] },
    ],
    selected: { optionId: 'opt:a', reason: ['skill-match'] },
    auditTrail: [{ actor: 'solver:s', action: 'decided', at: '2026-08-16T08:00:00Z' }],
    ...overrides,
  };
}

describe('validateDecision（Canonical Decision Model）', () => {
  it('注册表形状：8 类决策目录 / 5 态生命周期 / 5 类权威封闭', () => {
    expect(DECISION_KINDS).toHaveLength(8);
    expect(DECISION_STATUSES).toHaveLength(5);
    expect(DECISION_AUTHORITIES).toHaveLength(5);
  });

  it('§31 单一事实源：DECISION_RISK_LEVELS 即 risk 契约阶梯（不重复定义）', () => {
    expect(DECISION_RISK_LEVELS).toBe(RISK_SEVERITY_LADDER);
    expect([...DECISION_RISK_LEVELS]).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('八类决策 kind 全部合法（Decision Catalog v1）', () => {
    for (const kind of DECISION_KINDS) {
      expect(validateDecision(record({ kind }))).toEqual([]);
    }
  });

  it('未知 kind/status/authority/风险等级 → 显式拒绝（注册表封闭）', () => {
    expect(validateDecision(record({ kind: 'future_kind' }))).toEqual(['unknown_kind']);
    expect(validateDecision(record({ status: 'confirmed' }))).toEqual(['unknown_status']);
    expect(validateDecision(record({ decisionAuthority: 'llm' }))).toEqual(['unknown_authority']);
    expect(validateDecision(record({ riskLevel: 'severe' }))).toEqual(['unknown_risk_level']);
  });

  it('decisionId 规范前缀 + subject 规范身份 + tenantId 必填', () => {
    expect(validateDecision(record({ decisionId: 'd-1' }))).toEqual(['bad_decision_id']);
    expect(validateDecision(record({ subject: 'task-t-1' }))).toEqual(['bad_subject']);
    expect(validateDecision(record({ tenantId: '' }))).toEqual(['bad_tenant']);
    expect(validateDecision(record({ requiresApproval: 'yes' }))).toEqual(['bad_approval_flag']);
  });

  it('selected.reason 非空强制 + selected 必须在 options 中 + optionId 唯一', () => {
    expect(validateDecision(record({ selected: { optionId: 'opt:a', reason: [] } })))
      .toEqual(['selected_reason_required']);
    expect(validateDecision(record({ selected: { optionId: 'opt:ghost', reason: ['r'] } })))
      .toEqual(['unknown_selected_option']);
    expect(validateDecision(record({
      options: [
        { optionId: 'opt:a', score: 90, reasons: [] },
        { optionId: 'opt:a', score: 80, reasons: [] },
      ],
    }))).toEqual(['duplicate_option']);
  });

  it('审批判定事实：human 决策或 approved/rejected 状态必带 approver', () => {
    expect(validateDecision(record({ decisionAuthority: 'human' }))).toEqual(['approver_required']);
    expect(validateDecision(record({ status: 'approved' }))).toEqual(['approver_required']);
    expect(validateDecision(record({
      status: 'approved',
      approver: { actor: 'person:op-1', at: '2026-08-16T08:30:00Z' },
    }))).toEqual([]);
    expect(validateDecision(record({
      decisionAuthority: 'human',
      approver: { actor: 'person:op-1', at: '2026-08-16T08:00:00Z' },
    }))).toEqual([]);
  });

  it('approver.at 不得早于 decidedAt（时间不倒退）', () => {
    expect(validateDecision(record({
      status: 'approved',
      approver: { actor: 'person:op-1', at: '2026-08-16T07:00:00Z' },
    }))).toEqual(['time_order_violation']);
  });

  it('auditTrail 非空强制 + 逐条判定事实（actor 规范身份/action 非空/at ISO）', () => {
    expect(validateDecision(record({ auditTrail: [] }))).toEqual(['audit_required']);
    expect(validateDecision(record({
      auditTrail: [{ actor: 'solver:s', action: 'decided', at: 'not-a-time' }],
    }))).toEqual(['bad_audit_entry']);
    expect(validateDecision(record({
      auditTrail: [{ actor: 'solver:s', action: '', at: '2026-08-16T08:00:00Z' }],
    }))).toEqual(['bad_audit_entry']);
  });

  it('坏权重/坏证据/缺字段/非对象 → 显式错误码（fail-closed）', () => {
    expect(validateDecision(record({ weightsSnapshot: { on_time: '0.4' } }))).toEqual(['bad_weights']);
    expect(validateDecision(record({ evidence: [''] }))).toEqual(['bad_evidence']);
    expect(validateDecision(null)).toEqual(['record_must_be_object']);
    expect(validateDecision({})).toEqual(['missing_field:decisionId']);
    const { selected, ...rest } = record();
    expect(validateDecision(rest)).toEqual(['missing_field:selected']);
  });
});
