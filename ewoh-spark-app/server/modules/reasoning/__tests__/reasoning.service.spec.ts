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

/** NO-25a：`evaluate` 路径不触碰世界模型/环境读数，这里给最小占位实现。 */
function makeUnusedSnapshots() {
  return { buildSnapshotReadOnly: jest.fn() };
}

function makeUnusedDb() {
  return { select: jest.fn() };
}

/** NO-27a：物料服务替身（默认"没有物料事件" → 不产出物料事实）。 */
function makeMaterials(projection: unknown = { balances: [], unparsable: [], generatedAt: '2026-09-12T10:00:00.000Z' }) {
  return { getInventory: jest.fn().mockResolvedValue(projection) };
}

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
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
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
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    await expect(
      service.evaluate({ ...FULL_INPUT, facts: [fact('not-an-id', 'person', { workload: 0.9 })] }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('输入 fail-closed：空证据链拒绝（§3 可追溯）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    await expect(
      service.evaluate(
        { ...FULL_INPUT, facts: [{ ...fact(PERSON, 'person', { workload: 0.9 }), evidenceIds: [] }] },
        ORG_A,
      ),
    ).rejects.toThrow('evidenceIds');
  });

  it('org 缺失显式失败（RLS 下不静默写全局）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    await expect(service.evaluate(FULL_INPUT, '')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('评估成功：六规则按注册表顺序 + 结论逐条 L4 台账落账 + inferenceIds 映射', async () => {
    const inference = makeInference();
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
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
    expect(result.ledgerFailures).toEqual([]);
    expect(result.inferenceIds[0]?.conclusionId).toContain('worker-overload');
  });

  it('无触发 → 空结论显式语义（不落账）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
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
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    const result = await service.evaluate(FULL_INPUT, ORG_A);
    const conclusions = (result.trace as Record<string, unknown>).conclusions as unknown[];
    expect(conclusions).toHaveLength(6);
    expect(result.inferenceIds).toEqual([]);
    expect(result.ledgerFailures).toHaveLength(6);
    expect(result.ledgerFailures[0]).toMatchObject({
      ruleId: 'rule:worker-overload',
      error: 'ledger down',
    });
  });

  it('traceId 缺省时生成唯一 ID（同秒多次评估不碰撞）', async () => {
    const inference = makeInference();
    const service = new ReasoningService(
      inference as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    const input = {
      snapshotVersion: 0,
      facts: [fact(PERSON, 'person', { workload: 0.1, fatigue: 0.1, ergonomicRisk: 0.1 })],
    };
    const first = await service.evaluate(input, ORG_A);
    const second = await service.evaluate(input, ORG_A);
    const firstTrace = first.trace as Record<string, unknown>;
    const secondTrace = second.trace as Record<string, unknown>;
    expect(firstTrace.traceId).not.toBe(secondTrace.traceId);
    expect(String(firstTrace.traceId)).toMatch(/^rt-[0-9a-f-]{36}$/);
  });

  it('listRules 返回六条注册表（可解释面：trigger/severity）', () => {
    const service = new ReasoningService(
      makeInference() as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    const rules = service.listRules();
    expect(rules).toHaveLength(6);
    expect(rules[0]?.ruleId).toBe('rule:worker-overload');
    expect(rules[0]?.trigger).toContain('workload');
    expect(rules[2]?.severity).toBe('critical');
  });

  it('ADR-026 激活面：approved 提案的阈值覆盖进入真实评估（人审激活，无提案=内置常量）', async () => {
    const borderline = fact(PERSON, 'person', { workload: 0.78, fatigue: 0.75, ergonomicRisk: 0.1 });
    const proposals = makeProposals({ workload: 0.75 });
    const service = new ReasoningService(
      makeInference() as never,
      proposals as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    const result = await service.evaluate(
      { traceId: 'rt-activation', snapshotVersion: 0, facts: [borderline] },
      ORG_A,
    );
    const conclusions = (result.trace as Record<string, unknown>).conclusions as unknown[];
    expect(conclusions).toHaveLength(1);
    expect((conclusions[0] as Record<string, unknown>).ruleId).toBe('rule:worker-overload');
    expect(proposals.getActiveThresholds).toHaveBeenCalledWith(ORG_A);
    // 无 approved 提案 → 阈值回落引擎内置常量（0.78 < 0.8 不触发）
    const baselineService = new ReasoningService(
      makeInference() as never,
      makeProposals() as never,
      makeUnusedSnapshots() as never,
      makeUnusedDb() as never,
    );
    const baseline = await baselineService.evaluate(
      { traceId: 'rt-activation', snapshotVersion: 0, facts: [borderline] },
      ORG_A,
    );
    expect((baseline.trace as Record<string, unknown>).conclusions).toEqual([]);
  });

  // ── NO-25a：从实时世界模型评估（观测事实投影）──────────────────────────────
  describe('evaluateLive / listLiveFacts（NO-25a 观测事实投影）', () => {
    // 锚点必须是**当前时间**：投影按 `ts >= now - 15min` 用真实时钟过滤，
    // 硬编码时间戳会让这套用例在写下的 15 分钟后必然全红
    // （实测：2026-09-12 10:35 UTC 起 6 例失败，报"读数已过期 30 分钟"）。
    const NOW_MS = Date.now();

    const sensorDevice = {
      id: 'uuid-env-1',
      deviceId: 'ENV-1',
      workerName: null,
      deviceModel: 'VIB-SENSOR',
      batteryPct: null,
      online: true,
      status: 'AVAILABLE',
      observedCapabilities: ['observe.vibration'],
    };

    const snapshot = {
      snapshotVersion: 'WS-LIVE',
      ts: new Date(NOW_MS).toISOString(),
      worldVersion: 7,
      entityVersions: {},
      reservations: [],
      persons: [],
      devices: [sensorDevice],
      tasks: [],
      stations: [],
      events: [],
    };

    const envRow = (overrides: Record<string, unknown> = {}) => ({
      sensorId: 'ENV-1',
      entityId: 'ENV-1',
      temperature: 25,
      vibration: 9.2,
      noise: 60,
      airQuality: 10,
      ts: new Date(NOW_MS - 60_000),
      sourceType: 'real',
      dataConfidence: 1,
      ...overrides,
    });

    function makeDb(rows: Array<Record<string, unknown>>) {
      return {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(rows) })),
            })),
          })),
        })),
      };
    }

    const makeSnapshots = (value: unknown = snapshot) => ({
      buildSnapshotReadOnly: jest.fn().mockResolvedValue(value),
    });

    const service = (
      opts: { rows?: Array<Record<string, unknown>>; inference?: unknown; snapshots?: unknown; materials?: unknown } = {},
    ) =>
      new ReasoningService(
        (opts.inference ?? makeInference()) as never,
        makeProposals() as never,
        (opts.snapshots ?? makeSnapshots()) as never,
        makeDb(opts.rows ?? [envRow()]) as never,
        (opts.materials ?? makeMaterials()) as never,
      );

    it('新鲜高置信读数 + 已声明观测能力 → 振动风险结论 + 依据（阈值/来源/时间）', async () => {
      const result = await service().evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);

      const conclusions = (result.trace as Record<string, unknown>).conclusions as Array<
        Record<string, unknown>
      >;
      expect(conclusions).toHaveLength(1);
      expect(conclusions[0].ruleId).toBe('rule:machine-vibration-risk');
      expect(conclusions[0].subjectId).toBe('device:ENV-1');
      // 依据可见：数值、阈值、单位、观测时间、数据质量、来源
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toMatchObject({
        capability: 'observe.vibration',
        value: 9.2,
        threshold: 7.1,
        unit: 'mm/s',
        dataQuality: 'FRESH',
        sourceType: 'real',
      });
      expect(result.skipped).toEqual([]);
      expect(result.snapshotVersion).toBe(7);
      expect(result.readingsConsidered).toBe(1);
      expect(result.inferenceIds).toHaveLength(1);
      expect(result.facts.some((f) => f.subjectId === 'device:ENV-1')).toBe(true);
    });

    it('低置信读数不成为事实：进 skipped 且不产生结论（原则 7）', async () => {
      const result = await service({ rows: [envRow({ dataConfidence: 0.2 })] }).evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);

      const conclusions = (result.trace as Record<string, unknown>).conclusions as unknown[];
      expect(conclusions).toEqual([]);
      expect(result.evidence).toEqual([]);
      expect(result.skipped).toEqual([
        expect.objectContaining({ reason: 'low_confidence', subjectId: 'ENV-1' }),
      ]);
    });

    it('未声明观测能力的设备：读数被拒（能力模型权威）', async () => {
      const snapshots = makeSnapshots({
        ...snapshot,
        devices: [{ ...sensorDevice, observedCapabilities: ['observe.temperature'] }],
      });
      const result = await service({ snapshots }).evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      expect(result.facts).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ reason: 'capability_not_declared' });
    });

    it('没有事实时也如实返回空结论（不抛错、不编造占位事实）', async () => {
      const snapshots = makeSnapshots({ ...snapshot, devices: [] });
      const inference = makeInference();
      const result = await service({ rows: [], snapshots, inference }).evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      expect((result.trace as Record<string, unknown>).conclusions).toEqual([]);
      expect(result.facts).toEqual([]);
      expect(result.inferenceIds).toEqual([]);
      expect(inference.recordInferenceResult).not.toHaveBeenCalled();
    });

    it('worldVersion 为负（32 位哈希）→ 无符号重解释，不触发契约 400', async () => {
      // 回归：负 worldVersion 曾让 snapshotVersion 变成负数 → evaluate 直接 400，
      // 整条"实时评估"链路不可用（只读视图却是 200，问题藏得很深）。
      const snapshots = makeSnapshots({ ...snapshot, worldVersion: -2084554752 });
      const result = await service({ snapshots }).evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      expect(result.snapshotVersion).toBe((-2084554752) >>> 0);
      expect(result.snapshotVersion).toBeGreaterThanOrEqual(0);
      const conclusions = (result.trace as Record<string, unknown>).conclusions as unknown[];
      expect(conclusions).toHaveLength(1);
    });

    it('物料短缺：有库存且有阈值 → 产出 material 事实与短缺结论（rule:material-shortage 活了）', async () => {
      const materials = makeMaterials({
        balances: [
          {
            materialId: 'MAT-1',
            onHand: 12,
            unit: 'kg',
            minThreshold: 40,
            thresholdDeclaredAt: '2026-09-12T09:00:00.000Z',
            receipts: 1,
            consumptions: 1,
            movementCount: 2,
            lastMovementAt: '2026-09-12T09:30:00.000Z',
            negative: false,
            mixedUnits: false,
            evidenceIds: ['EV-1', 'EV-2'],
          },
        ],
        unparsable: [],
        generatedAt: '2026-09-12T10:00:00.000Z',
      });
      const result = await service({ snapshots: makeSnapshots({ ...snapshot, devices: [] }), rows: [], materials }).evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      expect(result.facts.some((f) => f.subjectId === 'material:MAT-1')).toBe(true);
      const conclusions = (result.trace as Record<string, unknown>).conclusions as Array<Record<string, unknown>>;
      expect(conclusions.some((c) => c.ruleId === 'rule:material-shortage')).toBe(true);
    });

    it('物料：没有阈值 / 历史不可解析载荷 → 不判定并如实进 skipped', async () => {
      const materials = makeMaterials({
        balances: [
          {
            materialId: 'MAT-2',
            onHand: 5,
            unit: 'kg',
            minThreshold: null,
            thresholdDeclaredAt: null,
            receipts: 1,
            consumptions: 0,
            movementCount: 1,
            lastMovementAt: '2026-09-12T09:30:00.000Z',
            negative: false,
            mixedUnits: false,
            evidenceIds: ['EV-9'],
          },
        ],
        unparsable: [{ eventId: 'ERP-X-1', type: 'material_consumption', reason: 'legacy_untyped_payload' }],
        generatedAt: '2026-09-12T10:00:00.000Z',
      });
      const result = await service({ snapshots: makeSnapshots({ ...snapshot, devices: [] }), rows: [], materials }).listLiveFacts({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      const reasons = result.skipped.map((s) => s.reason);
      expect(reasons).toContain('no_threshold');
      expect(reasons).toContain('unparsable_material_movement');
      expect(result.facts.some((f) => f.subjectId === 'material:MAT-2')).toBe(false);
    });

    it('物料服务抛错 → 降级为"物料未参与判定"且可见，不影响其它结论', async () => {
      const materials = { getInventory: jest.fn().mockRejectedValue(new Error('db down')) };
      const result = await service({ materials }).evaluateLive({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      expect(result.skipped.some((s) => s.reason === 'material_projection_failed')).toBe(true);
      // 观测事实照常评估（降级不牵连无关结论）
      const conclusions = (result.trace as Record<string, unknown>).conclusions as Array<Record<string, unknown>>;
      expect(conclusions.some((c) => c.ruleId === 'rule:machine-vibration-risk')).toBe(true);
    });

    it('缺 org 上下文 → 400（实时评估不接受全局查询）', async () => {
      await expect(service().evaluateLive(undefined)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service().listLiveFacts({ userId: 'u-1' } as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('listLiveFacts 只读：返回事实/依据/未采用数据但不落账', async () => {
      const inference = makeInference();
      const result = await service({ inference }).listLiveFacts({
        userId: 'u-1',
        primaryOrgId: ORG_A,
        roles: ['dispatcher'],
      } as never);
      expect(result.facts.some((f) => f.subjectId === 'device:ENV-1')).toBe(true);
      expect(result.evidence).toHaveLength(1);
      expect(result.limits.vibrationMmPerSec).toBe(7.1);
      expect(inference.recordInferenceResult).not.toHaveBeenCalled();
    });
  });
});
