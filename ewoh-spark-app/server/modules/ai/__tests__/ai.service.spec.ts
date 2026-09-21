/* AiService 建议流 ReasoningResult 附着测试（NO-08d / ADR-014）。
 *
 * 覆盖：LLM 成功/失败路径均附着 Canonical ReasoningResult（无标定置信度
 * 显式声明 + ok/error 映射）；规则模板回退（无 Ark）不附着 reasoning。
 */
/// <reference types="jest" />
import { AiService } from '../ai.service';
import { ArkService } from '../ark.service';

const INPUT = {
  triggeredBy: 'u1',
  snapshot: { version: 3, from: '2026-08-16T08:00:00Z', to: '2026-08-16T09:00:00Z', records: 12 },
  problem: '测试问题',
};

function makeArk(result: Record<string, unknown>) {
  return {
    ask: jest.fn().mockResolvedValue(result),
  };
}

describe('AiService（NO-08d 建议流元数据附着）', () => {
  it('LLM 成功：suggestion 附着 ReasoningResult（L4/suggestion/无置信度）', async () => {
    const ark = makeArk({
      ok: true,
      text: JSON.stringify({
        id: 'attacker-id',
        snapshotVersion: '999',
        triggeredBy: 'attacker',
        suggestion: '调整人员排班',
        basis: ['validated', 42],
      }),
      model: 'doubao-pro',
      reasoning: {
        reasoningId: 'RS-1',
        level: 'L4_industrial_reasoning',
        kind: 'suggestion',
        modelId: 'ark-chat',
        modelVersion: 'doubao-pro',
        inputVersion: 'scheduler-suggestion-v2',
        subjectId: null,
        content: JSON.stringify({ suggestion: '调整人员排班' }),
        ok: true,
        error: null,
        confidence: null,
        confidenceBasis: 'uncalibrated',
        evidence: { generatedAt: '2026-08-16T09:00:00Z' },
        contract_violations: [],
      },
    });
    const service = new AiService(undefined, ark as unknown as ArkService);
    const suggestion = await service.createSuggestion(INPUT);
    expect(suggestion.suggestion).toBe('调整人员排班');
    expect(suggestion.id).toMatch(/^sug-/);
    expect(suggestion.snapshotVersion).toBe(3);
    expect(suggestion.triggeredBy).toBe('u1');
    expect(suggestion.basis).toEqual(['validated']);
    const r = suggestion.reasoning as Record<string, unknown>;
    expect(r.kind).toBe('suggestion');
    expect(r.level).toBe('L4_industrial_reasoning');
    expect(r.confidence).toBeNull();
    expect(r.contract_violations).toEqual([]);
  });

  it('LLM 失败：suggestion 附着 ok=false reasoning + basis 记录不可用', async () => {
    const ark = makeArk({
      ok: false,
      text: '',
      model: 'doubao-pro',
      error: 'HTTP 500',
      reasoning: {
        reasoningId: 'RS-2',
        level: 'L4_industrial_reasoning',
        kind: 'suggestion',
        modelId: 'ark-chat',
        modelVersion: 'doubao-pro',
        inputVersion: 'scheduler-suggestion-v2',
        subjectId: null,
        content: '',
        ok: false,
        error: 'HTTP 500',
        confidence: null,
        confidenceBasis: 'uncalibrated',
        evidence: { generatedAt: '2026-08-16T09:01:00Z' },
        contract_violations: [],
      },
    });
    const service = new AiService(undefined, ark as unknown as ArkService);
    const suggestion = await service.createSuggestion(INPUT);
    expect(suggestion.basis.some((b) => b.includes('LLM 不可用'))).toBe(true);
    const r = suggestion.reasoning as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 500');
  });

  it('规则模板回退（无 Ark）：不附着 reasoning（不伪造）', async () => {
    const service = new AiService(undefined, undefined);
    const suggestion = await service.createSuggestion(INPUT);
    expect(suggestion.reasoning).toBeUndefined();
    expect(suggestion.suggestion).toContain('人工复核');
    expect(suggestion.basis).toContain('调用方声明的数据快照');
    expect(suggestion.risk).toContain('声明的快照元数据可能与权威世界模型不一致');
    expect(suggestion.uncertainty).toContain(
      '快照版本、时间范围和样本量由调用方声明，尚未在服务端复核',
    );
  });

  it('rejects malformed or contradictory caller-declared snapshot provenance', async () => {
    const service = new AiService(undefined, undefined);
    await expect(
      service.createSuggestion({
        ...INPUT,
        snapshot: { ...INPUT.snapshot, version: 1.5 },
      }),
    ).rejects.toThrow('snapshot.version must be a non-negative integer');
    await expect(
      service.createSuggestion({
        ...INPUT,
        snapshot: { ...INPUT.snapshot, records: -1 },
      }),
    ).rejects.toThrow('snapshot.records must be a non-negative integer');
    await expect(
      service.createSuggestion({
        ...INPUT,
        snapshot: { ...INPUT.snapshot, from: 'not-a-date' },
      }),
    ).rejects.toThrow('snapshot.from and snapshot.to must be valid dates');
    await expect(
      service.createSuggestion({
        ...INPUT,
        snapshot: { ...INPUT.snapshot, from: '2026-08-16T10:00:00Z', to: '2026-08-16T09:00:00Z' },
      }),
    ).rejects.toThrow('snapshot.from must not be after snapshot.to');
  });

  // ── NO-08a（ADR-019）：确定性规则基础 → L1 InferenceResult 台账 ──────────

  function makeInference(record: Record<string, unknown> = {}) {
    return {
      recordInferenceResult: jest.fn().mockResolvedValue({
        record: {
          inferenceId: 'inf-test-1',
          subjectId: 'decision:sug-1',
          level: 'L1_deterministic_rules',
          confidence: 1,
          ...record,
        },
        created: true,
      }),
    };
  }

  it('NO-08a：规则基础落账 L1 InferenceResult（confidence=1 如实声明 + inputVersion 快照版本）', async () => {
    const inference = makeInference();
    const service = new AiService(undefined, undefined, inference as never);
    const suggestion = await service.createSuggestion({ ...INPUT, orgId: 'org-a' });
    expect(inference.recordInferenceResult).toHaveBeenCalledTimes(1);
    const [payload, orgId] = inference.recordInferenceResult.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(orgId).toBe('org-a');
    expect(payload.level).toBe('L1_deterministic_rules');
    expect(payload.confidence).toBe(1);
    expect(payload.inputVersion).toBe('snapshot-v3');
    expect(payload.modelId).toBe('rule-a2-suggestion');
    expect((payload.oodIndicator as { flag: boolean; reasons: string[] }).flag).toBe(false);
    expect((payload.evidence as { isRule: boolean }).isRule).toBe(true);
    expect(suggestion.inference).toBeDefined();
    expect((suggestion.inference as Record<string, unknown>).confidence).toBe(1);
  });

  it('NO-08a：org 上下文缺失 → 显式跳过落账（不伪造租户）', async () => {
    const inference = makeInference();
    const service = new AiService(undefined, undefined, inference as never);
    const suggestion = await service.createSuggestion(INPUT);
    expect(inference.recordInferenceResult).not.toHaveBeenCalled();
    expect(suggestion.inference).toBeUndefined();
  });

  it('NO-08a：台账写入失败 → 主流程不中断（logger 留痕，建议照常返回）', async () => {
    const inference = {
      recordInferenceResult: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const service = new AiService(undefined, undefined, inference as never);
    const suggestion = await service.createSuggestion({ ...INPUT, orgId: 'org-a' });
    expect(suggestion.suggestion).toContain('人工复核');
    expect(suggestion.inference).toBeUndefined();
  });

  // ── NEST-449/422：createPlan / getSuggestion / getPlan / chatWithContext ──────

  const ACTOR_ORG_A = { userId: 'u1', primaryOrgId: 'org-a', roles: [] };
  const ACTOR_ORG_B = { userId: 'u2', primaryOrgId: 'org-b', roles: [] };

  function makeSuggestionDb(row: Record<string, unknown> | null) {
    const rows = row ? [row] : [];
    const fake = {
      select: jest.fn(() => fake),
      from: jest.fn(() => fake),
      where: jest.fn(() => Promise.resolve(rows)),
      insert: jest.fn(() => ({
        values: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([{ content: '{}' }])) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve([])) })),
      })),
      __rows: rows,
    };
    return fake;
  }

  const SUGGESTION_ROW = {
    suggestionId: 'sug-1',
    orgId: 'org-a',
    content: JSON.stringify({ id: 'sug-1', suggestion: '建议内容' }),
    planContent: null,
  };

  it('NEST-449：createPlan（内存路径）正常创建 shadow 方案', async () => {
    const service = new AiService(undefined, undefined);
    const suggestion = await service.createSuggestion(INPUT);
    const plan = await service.createPlan(suggestion.id, { shift: 'A' });
    expect(plan).toMatchObject({ suggestionId: suggestion.id, status: 'shadow', isSimulation: true });
  });

  it('NEST-449/422：getSuggestion 跨租户 404（org 守卫）', async () => {
    const service = new AiService(
      makeSuggestionDb(SUGGESTION_ROW) as never,
      undefined,
    );
    await expect(service.getSuggestion('sug-1', ACTOR_ORG_A)).resolves.toMatchObject({
      id: 'sug-1',
    });
    await expect(service.getSuggestion('sug-1', ACTOR_ORG_B)).rejects.toThrow(/not found/i);
  });

  it('NEST-449/422：getPlan 跨租户 404（org 守卫）', async () => {
    const db = makeSuggestionDb({
      ...SUGGESTION_ROW,
      planContent: { id: 'plan-1', suggestionId: 'sug-1', status: 'shadow' },
    });
    const service = new AiService(db as never, undefined);
    const plan = await service.getPlan('plan-1', ACTOR_ORG_A);
    expect(plan).toMatchObject({ id: 'plan-1' });
    await expect(service.getPlan('plan-1', ACTOR_ORG_B)).rejects.toThrow(/not found/i);
  });

  it('NEST-449/422：createPlan 跨租户 404（建议归属校验）', async () => {
    const service = new AiService(
      makeSuggestionDb(SUGGESTION_ROW) as never,
      undefined,
    );
    // org-b actor 读 org-a 的建议 → 404（绝不基于他租户建议生成方案）。
    await expect(
      service.createPlan('sug-1', { shift: 'A' }, ACTOR_ORG_B),
    ).rejects.toThrow(/not found/i);
  });

  it('NEST-449：chatWithContext 无 Ark → ok=false 显式返回（不抛错）', async () => {
    const db = makeSuggestionDb(null);
    const service = new AiService(db as never, undefined);
    const result = await service.chatWithContext('当前设备状态？', 'org-a');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未就绪');
  });
});

describe('AiService streamSuggestion untrusted-output and persistence boundary', () => {
  const streamInput = {
    triggeredBy: 'u-stream',
    snapshot: { version: 4, from: '2026-09-20T08:00:00Z', to: '2026-09-20T09:00:00Z', records: 8 },
    problem: '流式建议测试',
  };

  it('ignores LLM attempts to overwrite identity fields and malformed list items', async () => {
    const payload = JSON.stringify({
      id: 'attacker-id',
      snapshotVersion: '999999',
      triggeredBy: 'attacker',
      suggestion: '  validated suggestion  ',
      basis: ['validated basis', 42, null, ''],
      risk: ['validated risk'],
      uncertainty: 'not-an-array',
      confirmItems: ['confirm'],
      unexpectedNested: { forbidden: true },
    });
    const ark = {
      chatStream: async function* () {
        yield { text: payload.slice(0, 20) };
        yield { text: payload.slice(20) };
      },
    };
    const service = new AiService(undefined, ark as unknown as ArkService);

    const events = [];
    for await (const event of service.streamSuggestion(streamInput)) {
      events.push(event);
    }
    const done = events.at(-1) as { phase: string; suggestion?: { id: string; snapshotVersion: number; triggeredBy: string; suggestion: string; basis: string[]; uncertainty: string[] } };

    expect(done.phase).toBe('done');
    expect(done.suggestion?.id).toMatch(/^sug-/);
    expect(done.suggestion?.snapshotVersion).toBe(4);
    expect(done.suggestion?.triggeredBy).toBe('u-stream');
    expect(done.suggestion?.suggestion).toBe('validated suggestion');
    expect(done.suggestion?.basis).toEqual(['validated basis']);
    expect(done.suggestion?.uncertainty.length).toBeGreaterThan(0);
  });

  it('does not expose an unsaved suggestion when persistence fails', async () => {
    const service = new AiService({
      insert: () => {
        throw new Error('db down');
      },
    } as never);

    const events = [];
    for await (const event of service.streamSuggestion(streamInput)) {
      events.push(event);
    }
    const done = events.at(-1) as { phase: string; suggestion?: unknown; error?: string };

    expect(done.phase).toBe('done');
    expect(done.suggestion).toBeUndefined();
    expect(done.error).toContain('保存失败');
  });
});
