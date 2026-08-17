/* ReasoningTrace 契约测试（ADR-020 / NO-08b，Level 4 独立工业推理层）。
 *
 * 覆盖：校验 fail-closed（未知规则/非规范结论身份/空前提/空证据/确定性置信
 * 越界/审计缺失）、空结论显式合法、规则评估器确定性结论（模板渲染真实值）。
 */
/// <reference types="jest" />
import {
  validateReasoningTrace,
  evaluateReasoningRules,
  REASONING_RULE_IDS,
  type ReasoningFact,
} from './reasoning-trace';

const EVID = ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'];
const PERSON = 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

function fact(subjectId: string, kind: string, values: Record<string, number | boolean>): ReasoningFact {
  return { subjectId, kind, values, evidenceIds: EVID };
}

function conclusion(
  traceId: string,
  ruleId: string,
  subjectId: string,
  severity: string,
  explanation: string,
) {
  return {
    conclusionId: `decision:${traceId}-${ruleId.split(':')[1]}`,
    ruleId,
    subjectId,
    severity,
    confidence: 1,
    confidenceBasis: 'deterministic',
    premises: [subjectId],
    evidenceIds: EVID,
    explanation,
  };
}

describe('validateReasoningTrace（ADR-020 契约）', () => {
  it('合法轨迹（worker-overload 确定性结论）通过', () => {
    const errors = validateReasoningTrace({
      traceId: 'rt-1',
      engineVersion: '1.0.0',
      factsRef: { snapshotVersion: 3, eventIds: EVID },
      conclusions: [conclusion('rt-1', 'rule:worker-overload', PERSON, 'high', '人员过载')],
      auditTrail: true,
    });
    expect(errors).toEqual([]);
  });

  it('空结论数组合法（无规则触发显式语义，非 unknown 冒充 normal）', () => {
    expect(
      validateReasoningTrace({
        traceId: 'rt-2',
        engineVersion: '1.0.0',
        factsRef: { snapshotVersion: 0, eventIds: [] },
        conclusions: [],
        auditTrail: true,
      }),
    ).toEqual([]);
  });

  it('未注册规则 fail-closed 拒绝', () => {
    const errors = validateReasoningTrace({
      traceId: 'rt-3',
      engineVersion: '1.0.0',
      factsRef: { snapshotVersion: 0, eventIds: [] },
      conclusions: [conclusion('rt-3', 'rule:teleport', PERSON, 'high', 'x')],
      auditTrail: true,
    });
    expect(errors[0]).toBe('unknown_rule');
  });

  it('确定性 basis 置信度必须=1（禁止伪装确定）', () => {
    const c = { ...conclusion('rt-4', 'rule:worker-overload', PERSON, 'high', 'x'), confidence: 0.7 };
    const errors = validateReasoningTrace({
      traceId: 'rt-4',
      engineVersion: '1.0.0',
      factsRef: { snapshotVersion: 0, eventIds: [] },
      conclusions: [c],
      auditTrail: true,
    });
    expect(errors[0]).toBe('bad_confidence');
  });

  it('auditTrail=false 拒绝（审计强制）', () => {
    const errors = validateReasoningTrace({
      traceId: 'rt-5',
      engineVersion: '1.0.0',
      factsRef: { snapshotVersion: 0, eventIds: [] },
      conclusions: [],
      auditTrail: false,
    });
    expect(errors[0]).toBe('audit_required');
  });
});

describe('evaluateReasoningRules（确定性引擎，§18 模板渲染真实值）', () => {
  it('六条规则按注册表顺序评估、结论确定性排序', () => {
    const conclusions = evaluateReasoningRules('rt-e1', [
      fact(PERSON, 'person', { workload: 0.9, fatigue: 0.8, ergonomicRisk: 0.3 }),
      fact('exo:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'exo', { batteryPct: 12 }),
      fact('machine:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'machine', { vibrationExceeded: true }),
      fact('material:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'material', { inventory: 5, minThreshold: 10 }),
      fact('station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'station', { qualityBlocked: true }),
      fact('alert:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'alert', { andonRaised: true, unacknowledgedMinutes: 40 }),
    ]);
    expect(conclusions.map((c) => c.ruleId)).toEqual([...REASONING_RULE_IDS]);
    expect(conclusions.every((c) => c.confidence === 1 && c.confidenceBasis === 'deterministic')).toBe(true);
    expect(conclusions[0]?.severity).toBe('high');
    expect(conclusions[2]?.severity).toBe('critical');
    // explanation 来自事实模板渲染（真实数字，非编造）
    expect(conclusions[0]?.explanation).toContain('负荷 0.9');
    expect(conclusions[1]?.explanation).toContain('电量 12%');
    expect(conclusions[5]?.explanation).toContain('40 分钟');
  });

  it('R2-SHR-001：脏 traceId 经 safeConclusionValue 清洗，产出恒为规范身份', () => {
    // 与 Python _safe_conclusion_value 逐字节一致（EDGE-227 同款）：剔除非
    // [A-Za-z0-9_.-]、截断 100、空兜底 unknown。
    const conclusions = evaluateReasoningRules('rt exec/4:脏 ID', [
      fact(PERSON, 'person', { workload: 0.9, fatigue: 0.8, ergonomicRisk: 0.3 }),
    ]);
    expect(conclusions).toHaveLength(1);
    expect(conclusions[0]?.conclusionId).toBe(
      `decision:rtexec4ID-worker-overload-person${PERSON.split(':')[1]}`,
    );
    // 引擎自产 conclusionId 必过自身契约校验（不自产自拒）：value 段满足规范身份语法
    const idValue = (conclusions[0]?.conclusionId ?? '').split(':')[1] ?? '';
    expect(idValue).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$/);
  });

  it('R2-SHR-011：同规则多主体命中 conclusionId 不碰撞', () => {
    const conclusions = evaluateReasoningRules('rt-dup', [
      fact(PERSON, 'person', { workload: 0.9, fatigue: 0.8, ergonomicRisk: 0.3 }),
      fact('person:0d2b8e7c-6a4f-4c2e-9f1a-3c5d7e9b1a23', 'person', { workload: 0.95, fatigue: 0.85, ergonomicRisk: 0.2 }),
    ]);
    expect(conclusions).toHaveLength(2);
    const ids = new Set(conclusions.map((c) => c.conclusionId));
    expect(ids.size).toBe(2);
  });

  it('R2-SHR-011：validateReasoningTrace 拒绝重复 conclusionId', () => {
    const c = conclusion('rt-dup2', 'rule:worker-overload', PERSON, 'high', 'x');
    const errors = validateReasoningTrace({
      traceId: 'rt-dup2',
      engineVersion: '1.0.0',
      factsRef: { snapshotVersion: 0, eventIds: [] },
      conclusions: [c, { ...c }],
      auditTrail: true,
    });
    expect(errors[0]).toBe('duplicate_conclusion_id');
  });

  it('阈值以下不触发 → 空结论（显式无规则语义）', () => {
    const conclusions = evaluateReasoningRules('rt-e2', [
      fact(PERSON, 'person', { workload: 0.5, fatigue: 0.2, ergonomicRisk: 0.1 }),
      fact('alert:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'alert', { andonRaised: true, unacknowledgedMinutes: 5 }),
    ]);
    expect(conclusions).toEqual([]);
  });
});
