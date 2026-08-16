/* ReasoningResult 契约行为测试（ADR-014 / NO-08c）。
 *
 * 覆盖：confidence 必须 null（禁止伪造数值）、confidenceBasis 显式
 * uncalibrated、ok=false 必带 error / ok=true 禁带 error、content 成功必填、
 * level/kind 封闭注册表、subjectId null 合法或规范身份。
 * 共享向量由 scripts/audit-domain-contracts.js 独立仲裁（257/257）。
 */
/// <reference types="jest" />
import {
  validateReasoningResult,
  REASONING_LEVELS,
  REASONING_KINDS,
} from './reasoning-result';

const TASK = 'task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

const BASE: Record<string, unknown> = {
  reasoningId: 'RS-1',
  level: 'L4_industrial_reasoning',
  kind: 'suggestion',
  modelId: 'ark-chat',
  modelVersion: 'doubao-pro',
  inputVersion: 'scheduler-suggestion-v2',
  subjectId: TASK,
  content: '建议将任务分配给具备焊接资质的人员。',
  ok: true,
  error: null,
  confidence: null,
  confidenceBasis: 'uncalibrated',
  evidence: { generatedAt: '2026-08-16T09:00:00Z' },
};

describe('reasoning-result contract', () => {
  it('合法结果：suggestion / chat 无主体 / 失败结果', () => {
    expect(validateReasoningResult(BASE)).toEqual([]);
    expect(
      validateReasoningResult({
        ...BASE,
        level: 'L5_agentic_workflow',
        kind: 'chat',
        subjectId: null,
        inputVersion: 'chat-v1',
      }),
    ).toEqual([]);
    expect(
      validateReasoningResult({
        ...BASE,
        kind: 'analysis',
        subjectId: null,
        content: '',
        ok: false,
        error: 'HTTP 429: rate limited',
      }),
    ).toEqual([]);
  });

  it('confidence 出现数值 → confidence_forbidden（禁止伪造置信度）', () => {
    expect(validateReasoningResult({ ...BASE, confidence: 0.9 })).toEqual([
      'confidence_forbidden',
    ]);
  });

  it('confidenceBasis 非 uncalibrated → confidence_basis_required（显式声明强制）', () => {
    expect(validateReasoningResult({ ...BASE, confidenceBasis: 'calibrated' })).toEqual([
      'confidence_basis_required',
    ]);
  });

  it('ok=false 必须带 error；ok=true 禁带 error', () => {
    expect(
      validateReasoningResult({ ...BASE, ok: false, content: '', error: null }),
    ).toEqual(['error_required']);
    expect(validateReasoningResult({ ...BASE, error: '多余' })).toEqual([
      'error_forbidden',
    ]);
  });

  it('ok=true 成功结果 content 不得为空', () => {
    expect(validateReasoningResult({ ...BASE, content: '' })).toEqual([
      'empty_content',
    ]);
  });

  it('注册表与 subject 契约', () => {
    expect(validateReasoningResult({ ...BASE, level: 'L2_statistical_ml' })).toEqual([
      'unknown_level',
    ]);
    expect(validateReasoningResult({ ...BASE, kind: 'poem' })).toEqual(['unknown_kind']);
    expect(validateReasoningResult({ ...BASE, subjectId: 'not-canonical' })).toEqual([
      'bad_subject',
    ]);
    expect(REASONING_LEVELS).toEqual([
      'L4_industrial_reasoning',
      'L5_agentic_workflow',
    ]);
    expect(REASONING_KINDS).toEqual(['suggestion', 'explanation', 'analysis', 'chat']);
  });
});
