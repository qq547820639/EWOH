/* InferenceResult 契约行为测试（ADR-013 / NO-08a）。
 *
 * 覆盖：confidence [0,1] fail-closed、OOD flag↔reasons 双向一致（封闭六路注册表）、
 * Unknown 合法化（unknown 必须带 OOD 理由）、Level 1-7 注册表、元数据必填、
 * subject 规范身份。共享向量由 scripts/audit-domain-contracts.js 独立仲裁
 * （238/238）。
 */
/// <reference types="jest" />
import {
  validateInferenceResult,
  INFERENCE_LEVELS,
  OOD_REASONS,
} from './inference-result';

const SUBJECT = 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

const BASE: Record<string, unknown> = {
  inferenceId: 'INF-1',
  subjectId: SUBJECT,
  level: 'L2_statistical_ml',
  modelId: 'action-classifier',
  modelVersion: 'v3',
  inputVersion: 'features-v7',
  label: 'lift',
  confidence: 0.87,
  oodIndicator: { flag: false, reasons: [] },
  dataQuality: 'good',
  evidence: {
    tsStart: '2026-08-16T08:00:00Z',
    tsEnd: '2026-08-16T08:00:12Z',
    isRule: false,
    keyFeatures: ['torque_mean'],
  },
};

describe('inference-result contract', () => {
  it('合法模型/规则/unknown 记录校验通过', () => {
    expect(validateInferenceResult(BASE)).toEqual([]);
    expect(
      validateInferenceResult({
        ...BASE,
        level: 'L1_deterministic_rules',
        modelId: 'rules',
        modelVersion: 'rule-fallback',
        inputVersion: 'rules-v12',
        label: 'walk',
        confidence: 0.65,
        dataQuality: 'degraded',
        evidence: { ...(BASE.evidence as object), isRule: true },
      }),
    ).toEqual([]);
    // Unknown 合法化：unknown + OOD 理由 → 合法。
    expect(
      validateInferenceResult({
        ...BASE,
        label: 'unknown',
        confidence: 0.31,
        oodIndicator: { flag: true, reasons: ['low_confidence'] },
      }),
    ).toEqual([]);
  });

  it('confidence 越界 → bad_confidence（fail-closed）', () => {
    expect(validateInferenceResult({ ...BASE, confidence: 1.4 })).toEqual([
      'bad_confidence',
    ]);
    expect(validateInferenceResult({ ...BASE, confidence: -0.1 })).toEqual([
      'bad_confidence',
    ]);
  });

  it('OOD flag↔reasons 双向一致强制', () => {
    expect(
      validateInferenceResult({
        ...BASE,
        oodIndicator: { flag: true, reasons: [] },
      }),
    ).toEqual(['ood_reason_required']);
    expect(
      validateInferenceResult({
        ...BASE,
        oodIndicator: { flag: false, reasons: ['low_confidence'] },
      }),
    ).toEqual(['ood_flag_required']);
    expect(
      validateInferenceResult({
        ...BASE,
        oodIndicator: { flag: true, reasons: ['alien_invasion'] },
      }),
    ).toEqual(['unknown_ood_reason']);
  });

  it('unknown 必须带 OOD 理由（Unknown 合法化边界）', () => {
    expect(validateInferenceResult({ ...BASE, label: 'unknown' })).toEqual([
      'unknown_requires_ood',
    ]);
  });

  it('元数据必填与注册表：inputVersion 缺失 / 未知 level / 未知 dataQuality 拒绝', () => {
    const { inputVersion: _drop, ...missing } = BASE;
    expect(validateInferenceResult(missing)).toEqual(['missing_field:inputVersion']);
    expect(validateInferenceResult({ ...BASE, level: 'L8_quantum' })).toEqual([
      'unknown_level',
    ]);
    expect(validateInferenceResult({ ...BASE, dataQuality: 'excellent' })).toEqual([
      'bad_data_quality',
    ]);
  });

  it('注册表与 schema 顺序一致（Level 1-7 / OOD 六路）', () => {
    expect(INFERENCE_LEVELS).toHaveLength(7);
    expect(INFERENCE_LEVELS[0]).toBe('L1_deterministic_rules');
    expect(OOD_REASONS).toEqual([
      'data_quality', 'low_confidence', 'ambiguous', 'firmware_unverified',
      'out_of_distribution', 'sensor_channel_missing',
    ]);
  });
});
