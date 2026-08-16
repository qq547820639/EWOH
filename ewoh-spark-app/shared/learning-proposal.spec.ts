/* LearningProposal 契约测试（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿）。
 *
 * 覆盖：kind/status 封闭注册表（未知拒绝）、thresholdRules 白名单
 * （无影子评估器的规则/参数拒绝，§33）、影子评估前置（approved/rolled_back
 * 无 shadowEval 拒绝）、人审激活阶梯（approved 必须 approver+时间，
 * §2 绝不隐式自动执行）、rejected/rolled_back 理由强制、状态机转移、
 * 确定性影子评估器（与 Python 端逐项一致，Golden #20 + 门禁仲裁）。
 */
/// <reference types="jest" />
import {
  validateLearningProposal,
  proposalTransitionAllowed,
  evaluateRuleThresholdShadow,
} from './learning-proposal';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: 'lp:1234:abcd',
    kind: 'rule_threshold',
    status: 'proposed',
    change: {
      ruleId: 'rule:worker-overload',
      parameter: 'workloadThreshold',
      baselineValue: 0.8,
      candidateValue: 0.75,
    },
    auditTrail: true,
    ...overrides,
  };
}

const SHADOW = {
  baselineThreshold: 0.8,
  candidateThreshold: 0.75,
  factsCount: 3,
  baselineFires: 2,
  candidateFires: 3,
  addedSubjects: ['person:p2'],
  removedSubjects: [],
  riskLevel: 'low',
};

describe('validateLearningProposal（ADR-026 契约）', () => {
  it('合法 proposed 通过', () => {
    expect(validateLearningProposal(record())).toEqual([]);
  });

  it('合法 shadow_evaluated / approved（带影子 + 人审）通过', () => {
    expect(validateLearningProposal(record({ status: 'shadow_evaluated', shadowEval: SHADOW }))).toEqual([]);
    expect(
      validateLearningProposal(
        record({
          status: 'approved',
          shadowEval: SHADOW,
          approvedBy: 'person:approver-1',
          approvedAt: '2026-08-16T10:00:00Z',
        }),
      ),
    ).toEqual([]);
  });

  it('未知 kind → unknown_kind（§33 无引擎空类型拒绝）', () => {
    expect(validateLearningProposal(record({ kind: 'policy_weight' }))[0]).toBe('unknown_kind');
  });

  it('无影子评估器的规则/参数 → unsupported_threshold', () => {
    expect(
      validateLearningProposal(
        record({ change: { ...(record().change as Record<string, unknown>), ruleId: 'rule:exo-low-battery' } }),
      )[0],
    ).toBe('unsupported_threshold');
  });

  it('approved 无 shadowEval → shadow_eval_required（无影子证据的激活拒绝）', () => {
    expect(
      validateLearningProposal(
        record({
          status: 'approved',
          approvedBy: 'person:approver-1',
          approvedAt: '2026-08-16T10:00:00Z',
        }),
      )[0],
    ).toBe('shadow_eval_required');
  });

  it('approved 缺 approver → approver_required（§2 人审阶梯机器强制）', () => {
    expect(
      validateLearningProposal(
        record({ status: 'approved', shadowEval: SHADOW, approvedAt: '2026-08-16T10:00:00Z' }),
      )[0],
    ).toBe('approver_required');
  });

  it('rolled_back 缺理由 → rollback_reason_required（§33 不静默回滚）', () => {
    expect(
      validateLearningProposal(
        record({
          status: 'rolled_back',
          shadowEval: SHADOW,
          approvedBy: 'person:approver-1',
          approvedAt: '2026-08-16T10:00:00Z',
          rolledBackBy: 'person:approver-1',
        }),
      )[0],
    ).toBe('rollback_reason_required');
  });

  it('baseline == candidate → no_op_change；auditTrail=false → audit_required', () => {
    expect(
      validateLearningProposal(
        record({ change: { ...(record().change as Record<string, unknown>), candidateValue: 0.8 } }),
      )[0],
    ).toBe('no_op_change');
    expect(validateLearningProposal(record({ auditTrail: false }))[0]).toBe('audit_required');
  });
});

describe('proposalTransitionAllowed（ADR-026 状态机）', () => {
  it('proposed→shadow_evaluated / proposed→rejected；shadow_evaluated→approved/rejected；approved→rolled_back', () => {
    expect(proposalTransitionAllowed('proposed', 'shadow_evaluated')).toBe(true);
    expect(proposalTransitionAllowed('proposed', 'rejected')).toBe(true);
    expect(proposalTransitionAllowed('shadow_evaluated', 'approved')).toBe(true);
    expect(proposalTransitionAllowed('shadow_evaluated', 'rejected')).toBe(true);
    expect(proposalTransitionAllowed('approved', 'rolled_back')).toBe(true);
    expect(proposalTransitionAllowed('proposed', 'approved')).toBe(false);
    expect(proposalTransitionAllowed('rejected', 'approved')).toBe(false);
    expect(proposalTransitionAllowed('rolled_back', 'approved')).toBe(false);
  });
});

describe('evaluateRuleThresholdShadow（ADR-026 决策 2）', () => {
  const facts = [
    { subjectId: 'person:p1', kind: 'person', values: { workload: 0.82, fatigue: 0.8, ergonomicRisk: 0.2 } },
    { subjectId: 'person:p2', kind: 'person', values: { workload: 0.78, fatigue: 0.75, ergonomicRisk: 0.1 } },
    { subjectId: 'person:p3', kind: 'person', values: { workload: 0.9, fatigue: 0.9, ergonomicRisk: 0.9 } },
  ];

  it('收紧阈值（0.8→0.75）只增保护：added + riskLevel low', () => {
    expect(evaluateRuleThresholdShadow('rule:worker-overload', 0.8, 0.75, facts)).toEqual({
      baselineThreshold: 0.8,
      candidateThreshold: 0.75,
      factsCount: 3,
      baselineFires: 2,
      candidateFires: 3,
      addedSubjects: ['person:p2'],
      removedSubjects: [],
      riskLevel: 'low',
    });
  });

  it('放宽阈值移除保护：removed + riskLevel 阶梯（<0.15 → medium）', () => {
    const result = evaluateRuleThresholdShadow('rule:worker-overload', 0.8, 0.85, facts);
    expect(result.removedSubjects).toEqual(['person:p1']);
    expect(result.riskLevel).toBe('medium');
  });

  it('放宽 ≥0.15 移除保护：riskLevel high', () => {
    const result = evaluateRuleThresholdShadow('rule:worker-overload', 0.7, 0.95, facts);
    expect(result.riskLevel).toBe('high');
  });

  it('fail-closed：同阈值 / 非 person 事实 / 缺数值字段抛错', () => {
    expect(() => evaluateRuleThresholdShadow('rule:worker-overload', 0.8, 0.8, facts)).toThrow();
    expect(() =>
      evaluateRuleThresholdShadow('rule:worker-overload', 0.8, 0.75, [
        { subjectId: 'machine:m1', kind: 'machine', values: {} },
      ]),
    ).toThrow();
    expect(() =>
      evaluateRuleThresholdShadow('rule:worker-overload', 0.8, 0.75, [
        { subjectId: 'person:p1', kind: 'person', values: { workload: 0.9 } },
      ]),
    ).toThrow();
  });
});
