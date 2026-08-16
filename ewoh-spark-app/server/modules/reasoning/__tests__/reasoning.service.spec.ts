/* ReasoningService 契约行为测试（ADR-020 / NO-08b，Level 4 独立工业推理层）。
 *
 * 覆盖：输入 fail-closed（未知 fact kind / 非规范身份 / 空证据链 / org 缺失）、
 * 确定性规则评估（六规则按注册表顺序）、trace 契约自检、结论逐条 L4 台账
 * 落账（InferenceResultService 委托断言）、无触发空结论显式语义、落账失败
 * 不阻断评估响应（logger 留痕）。
 * 台账服务以 mock 替换（其自身契约由 inference.service.spec 10 例覆盖）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ReasoningService } from '../reasoning.service';

const EVID = ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'];
const PERSON = 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';
const ORG_A = 'org-a';

function fact(subjectId: string, kind: string, values: Record<string, number | boolean>) {
  return { subjectId, kind, values, evidenceIds: EVID };
}

const FULL_INPUT = {
  traceId: 'rt-test-1',
  snapshotVersion: 3,
  eventIds: EVID,
  facts: [
    fact(PERSON, 'person', { workload: 0.9, fatigue: 0.8, ergonomicRisk: 0.3 }),
    fact('exo:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'exo', { batteryPct: 12 }),
    fact('machine:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'machine', { vibrationExceeded: true }),
    fact('material:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'material', { inventory: 5, minThreshold: 10 }),
    fact('station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'station', { qualityBlocked: true }),
    fact('alert:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'alert', { andonRaised: true, unacknowledgedMinutes: 40 }),
  ],
};

function makeProposals(thresholds: Record<string, number> = {}) {
  return {
    getActiveThresholds: jest.fn().mockResolvedValue(thresholds),
  };
}

function makeInference(behavior: 'ok' | 'fail' = 'ok') {
  const recordInferenceResult = jest.fn().mockImplementation(async (input: Record<string, unknown>) => {
    if (behavior === 'fail') throw new Error('ledger down');
    return { record: { inferenceId: `inf-${input.modelId}`, ...input }, created: true };
  });
  return { recordInferenceResult };
}

describe('ReasoningService（NO-08b 独立工业推理层）', () => {
  it('输入 fail-closed：未知 fact kind 拒绝', async () => {
    const inference = makeInference();
    const service = new ReasoningService(inference as never, makeProposals() as never);
    await expect(
      service.evaluate(
        { ...FULL_INPUT, facts: [fact(PERSON, 'gizmo', { workload: 0.9 })] },
        ORG_A,
      ),
    ).rejects.toThrow('unknown_fact_kind:gizmo');
    expect(inference.recordInferenceResult).not.toHaveBeenCalled();
  });

  it('输入 fail-closed：非规范 subjectId 拒绝', async () => {
    const inference = makeInference();
    const service = new ReasoningService(inference as never, makeProposals() as never);
    await expect(
      service.evaluate({ ...FULL_INPUT, facts: [fact('not-an-id', 'person', { workload: 0.9 })] }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('输入 fail-closed：空证据链拒绝（§3 可追溯）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(inference as never, makeProposals() as never);
    await expect(
      service.evaluate(
        { ...FULL_INPUT, facts: [{ ...fact(PERSON, 'person', { workload: 0.9 }), evidenceIds: [] }] },
        ORG_A,
      ),
    ).rejects.toThrow('evidenceIds');
  });

  it('org 缺失显式失败（RLS 下不静默写全局）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(inference as never, makeProposals() as never);
    await expect(service.evaluate(FULL_INPUT, '')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('评估成功：六规则按注册表顺序 + 结论逐条 L4 台账落账 + inferenceIds 映射', async () => {
    const inference = makeInference();
    const service = new ReasoningService(inference as never, makeProposals() as never);
    const result = await service.evaluate(FULL_INPUT, ORG_A);
    const trace = result.trace as Record<string, unknown>;
    expect(trace.engineVersion).toBe('1.0.0');
    expect(trace.auditTrail).toBe(true);
    expect((trace.factsRef as Record<string, unknown>).snapshotVersion).toBe(3);
    const conclusions = trace.conclusions as Array<Record<string, unknown>>;
    expect(conclusions.map((c) => c.ruleId)).toEqual([
      'rule:worker-overload', 'rule:exo-low-battery', 'rule:machine-vibration-risk',
      'rule:material-shortage', 'rule:station-quality-blocked', 'rule:andon-escalation',
    ]);
    expect(inference.recordInferenceResult).toHaveBeenCalledTimes(6);
    const firstCall = inference.recordInferenceResult.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(firstCall[1]).toBe(ORG_A);
    expect(firstCall[0].level).toBe('L4_industrial_reasoning');
    expect(firstCall[0].modelId).toBe('reasoning:rule:worker-overload');
    expect(firstCall[0].inputVersion).toBe('snapshot-v3');
    expect((firstCall[0].evidence as { isRule: boolean }).isRule).toBe(true);
    expect(result.inferenceIds).toHaveLength(6);
    expect(result.inferenceIds[0]?.conclusionId).toContain('worker-overload');
  });

  it('无触发 → 空结论显式语义（不落账）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(inference as never, makeProposals() as never);
    const result = await service.evaluate(
      {
        traceId: 'rt-test-2',
        snapshotVersion: 0,
        facts: [fact(PERSON, 'person', { workload: 0.5, fatigue: 0.2, ergonomicRisk: 0.1 })],
      },
      ORG_A,
    );
    expect((result.trace as Record<string, unknown>).conclusions).toEqual([]);
    expect(inference.recordInferenceResult).not.toHaveBeenCalled();
    expect(result.inferenceIds).toEqual([]);
  });

  it('落账失败 → 评估响应正常（logger 留痕不阻断主契约），该结论无 inferenceId', async () => {
    const inference = makeInference('fail');
    const service = new ReasoningService(inference as never, makeProposals() as never);
    const result = await service.evaluate(FULL_INPUT, ORG_A);
    const conclusions = (result.trace as Record<string, unknown>).conclusions as unknown[];
    expect(conclusions).toHaveLength(6);
    expect(result.inferenceIds).toEqual([]);
  });

  it('listRules 返回六条注册表（可解释面：trigger/severity）', () => {
    const service = new ReasoningService(makeInference() as never, makeProposals() as never);
    const rules = service.listRules();
    expect(rules).toHaveLength(6);
    expect(rules[0]?.ruleId).toBe('rule:worker-overload');
    expect(rules[0]?.trigger).toContain('workload');
    expect(rules[2]?.severity).toBe('critical');
  });

  it('ADR-026 激活面：approved 提案的阈值覆盖进入真实评估（人审激活，无提案=内置常量）', async () => {
    const borderline = fact(PERSON, 'person', { workload: 0.78, fatigue: 0.75, ergonomicRisk: 0.1 });
    const proposals = makeProposals({ workload: 0.75 });
    const service = new ReasoningService(makeInference() as never, proposals as never);
    const result = await service.evaluate(
      { traceId: 'rt-activation', snapshotVersion: 0, facts: [borderline] },
      ORG_A,
    );
    const conclusions = (result.trace as Record<string, unknown>).conclusions as unknown[];
    expect(conclusions).toHaveLength(1);
    expect((conclusions[0] as Record<string, unknown>).ruleId).toBe('rule:worker-overload');
    expect(proposals.getActiveThresholds).toHaveBeenCalledWith(ORG_A);
    // 无 approved 提案 → 阈值回落引擎内置常量（0.78 < 0.8 不触发）
    const baselineService = new ReasoningService(makeInference() as never, makeProposals() as never);
    const baseline = await baselineService.evaluate(
      { traceId: 'rt-activation', snapshotVersion: 0, facts: [borderline] },
      ORG_A,
    );
    expect((baseline.trace as Record<string, unknown>).conclusions).toEqual([]);
  });
});
