/* LearningEvaluation 契约测试（ADR-021 / NO-09a，Phase 12 Continuous Learning）。
 *
 * 覆盖：七项指标封闭注册表（缺键/未知键拒绝）、null 语义（无数据/unknown
 * 合法，非 number 拒绝）、period 契约（倒置拒绝）、basis 非空、auditTrail 强制。
 */
/// <reference types="jest" />
import { validateLearningEvaluation, LEARNING_METRIC_KEYS } from './learning-evaluation';

const NULL_METRICS: Record<string, unknown> = Object.fromEntries(
  LEARNING_METRIC_KEYS.map((k) => [k, null]),
);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evalId: 'le:periodic:2026-08-16T00:00:00Z',
    orgId: 'org-1',
    evaluationType: 'periodic',
    periodStart: '2026-08-16T00:00:00Z',
    periodEnd: '2026-08-16T08:00:00Z',
    engineVersion: '1.0.0',
    metrics: { ...NULL_METRICS },
    basis: ['x'],
    auditTrail: true,
    ...overrides,
  };
}

describe('validateLearningEvaluation（ADR-021 契约）', () => {
  it('合法快照（七键全 null = 无数据语义）通过', () => {
    expect(validateLearningEvaluation(record())).toEqual([]);
  });

  it('合法快照（部分数值 + modelAccuracy null unknown）通过', () => {
    expect(
      validateLearningEvaluation(
        record({ metrics: { ...NULL_METRICS, planSuccessRate: 0.9, modelAccuracy: null } }),
      ),
    ).toEqual([]);
  });

  it('缺指标键 → metric_missing', () => {
    const metrics = { ...NULL_METRICS };
    delete (metrics as Record<string, unknown>).modelAccuracy;
    expect(validateLearningEvaluation(record({ metrics }))[0]).toBe('metric_missing');
  });

  it('未知指标键 → unknown_metric', () => {
    expect(
      validateLearningEvaluation(record({ metrics: { ...NULL_METRICS, teleportRate: 1 } }))[0],
    ).toBe('unknown_metric');
  });

  it('非 number 指标值 → bad_metric_value（null 合法，字符串伪造拒绝）', () => {
    expect(
      validateLearningEvaluation(record({ metrics: { ...NULL_METRICS, planSuccessRate: 'high' } }))[0],
    ).toBe('bad_metric_value');
  });

  it('倒置 period → bad_period', () => {
    expect(
      validateLearningEvaluation(
        record({ periodStart: '2026-08-16T08:00:00Z', periodEnd: '2026-08-16T00:00:00Z' }),
      )[0],
    ).toBe('bad_period');
  });

  it('basis 空 → basis_required；auditTrail=false → audit_required', () => {
    expect(validateLearningEvaluation(record({ basis: [] }))[0]).toBe('basis_required');
    expect(validateLearningEvaluation(record({ auditTrail: false }))[0]).toBe('audit_required');
  });
});
