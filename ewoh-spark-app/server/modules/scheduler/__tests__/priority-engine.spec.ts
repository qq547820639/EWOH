import {
  PriorityEngine,
  computeEffectivePriorityResults,
} from '../priority-engine';
import { buildSnapshot, defaultConfig, defaultPolicy } from './scheduler-test-helpers';

describe('PriorityEngine（Task 0.4）', () => {
  const engine = new PriorityEngine();
  const config = defaultConfig();
  const policy = defaultPolicy();
  const now = 0;
  const horizonEndMs = 480 * 60 * 1000; // 8h

  function compute(task: {
    id: string;
    priority: string;
    planStart?: string | null;
    planEnd?: string | null;
    productionImpact?: number;
  }) {
    return engine.compute(policy, {
      task,
      config,
      now,
      horizonEndMs,
      downstreamCount: new Map(),
      manualBoostIds: new Set(),
    });
  }

  it('critical/urgent 硬地板优先（score 更小、urgent=true）', () => {
    const critical = compute({ id: 'c', priority: 'critical' });
    const high = compute({ id: 'h', priority: 'high' });
    const medium = compute({ id: 'm', priority: 'medium' });
    const low = compute({ id: 'l', priority: 'low' });
    expect(critical.urgent).toBe(true);
    expect(critical.score).toBeLessThan(high.score);
    expect(high.score).toBeLessThan(medium.score);
    expect(medium.score).toBeLessThan(low.score);
  });

  it('同优先级下截止时间更近者 score 更小（方向正确）', () => {
    // 两个 medium：A 截止 1h 后，B 截止 8h 后
    const near = compute({
      id: 'a',
      priority: 'medium',
      planEnd: new Date(now + 3600_000).toISOString(),
    });
    const far = compute({
      id: 'b',
      priority: 'medium',
      planEnd: new Date(now + horizonEndMs).toISOString(),
    });
    expect(near.score).toBeLessThan(far.score);
    // 更近 deadline 的排序应更靠前
    expect([far, near].sort((x, y) => x.score - y.score)[0].score).toBe(near.score);
  });

  it('等待老化越久越紧急（score 更小）', () => {
    const idle = compute({
      id: 'x',
      priority: 'medium',
      planEnd: new Date(now + 3600_000).toISOString(),
    });
    const aged = compute({
      id: 'y',
      priority: 'medium',
      planStart: new Date(now - 3600_000).toISOString(),
      planEnd: new Date(now + 3600_000).toISOString(),
    });
    expect(aged.score).toBeLessThan(idle.score);
  });

  it('factors 提供可解释性，contains 同步生成', () => {
    const r = compute({ id: 'z', priority: 'high', planEnd: new Date(now + 3600_000).toISOString() });
    expect(Array.isArray(r.factors)).toBe(true);
    expect(r.factors.length).toBeGreaterThan(0);
    expect(r.explanation.length).toBe(r.factors.length);
    expect(r.factors.some((f) => f.name === 'base_priority')).toBe(true);
    expect(r.factors.some((f) => f.name === 'deadline_risk')).toBe(true);
  });

  it('productionImpact 越高越紧急（score 更小，factors/explanation 同步）', () => {
    const base = compute({
      id: 'p0',
      priority: 'medium',
      planEnd: new Date(now + 3600_000).toISOString(),
    });
    const impactful = compute({
      id: 'p1',
      priority: 'medium',
      planEnd: new Date(now + 3600_000).toISOString(),
      productionImpact: 0.8,
    });
    // 高影响度应缩小 score（更紧急）
    expect(impactful.score).toBeLessThan(base.score);
    // factors 出现 production_impact 且 value 正确
    const piFactor = impactful.factors.find((f) => f.name === 'production_impact');
    expect(piFactor).toBeDefined();
    expect(piFactor!.value).toBe(0.8);
    expect(piFactor!.term).toBeLessThan(0);
    // explanation 同步生成
    expect(impactful.explanation.some((e) => e.startsWith('production_impact='))).toBe(true);
    expect(impactful.explanation.length).toBe(impactful.factors.length);
  });

  it('productionImpact 缺省/为 0 时不产生额外因子（向后兼容）', () => {
    const r = compute({
      id: 'p2',
      priority: 'medium',
      planEnd: new Date(now + 3600_000).toISOString(),
    });
    expect(r.factors.some((f) => f.name === 'production_impact')).toBe(false);
  });

  it('生产影响度不会覆盖 safety-critical 硬约束（不改变 urgent/level 语义）', () => {
    // 高生产影响度只会缩小 score，绝不改变 critical 任务的 urgent/level，
    // 也不绕过硬约束阻断（SAFETY_BLOCK 在求解器校验阶段单独强制，与 score 无关）。
    const criticalPlain = compute({ id: 'sc', priority: 'critical' });
    const criticalImp = compute({
      id: 'sc2',
      priority: 'critical',
      productionImpact: 1,
    });
    // critical 硬地板语义保持不变
    expect(criticalPlain.urgent).toBe(true);
    expect(criticalPlain.level).toBe(0);
    expect(criticalImp.urgent).toBe(true);
    expect(criticalImp.level).toBe(0);
    // 生产影响度可缩小 score，但 urgent/level 依旧为硬地板
    expect(criticalImp.score).toBeLessThan(criticalPlain.score);
    // 返回结构保持 { level, score, urgent, factors, explanation }
    expect(criticalImp).toHaveProperty('level');
    expect(criticalImp).toHaveProperty('score');
    expect(criticalImp).toHaveProperty('urgent');
    expect(criticalImp).toHaveProperty('factors');
    expect(criticalImp).toHaveProperty('explanation');
  });

  // ========================================================================
  // T03 / P1-1（G4）：event_severity 分支真实触发 + policyVersion 输出
  // ========================================================================

  it('开放 L2/L3 事件 → event_severity factor 出现（死路径修复）', () => {
    const r = engine.compute(policy, {
      task: { id: 'e1', priority: 'medium', planEnd: new Date(now + 3600_000).toISOString() },
      config,
      now,
      horizonEndMs,
      downstreamCount: new Map(),
      manualBoostIds: new Set(),
      events: [{ eventType: 'DEVICE_OFFLINE', severity: 'high' }],
    });
    const sev = r.factors.find((f) => f.name === 'event_severity');
    expect(sev).toBeDefined();
    expect(r.explanation.some((e) => e.startsWith('event_severity='))).toBe(true);
    // low 不触发；DEADLINE_AT_RISK 触发。
    const benign = engine.compute(policy, {
      task: { id: 'e2', priority: 'medium' },
      config, now, horizonEndMs, downstreamCount: new Map(), manualBoostIds: new Set(),
      events: [{ eventType: 'X', severity: 'low' }],
    });
    expect(benign.factors.some((f) => f.name === 'event_severity')).toBe(false);
    const deadline = engine.compute(policy, {
      task: { id: 'e3', priority: 'medium' },
      config, now, horizonEndMs, downstreamCount: new Map(), manualBoostIds: new Set(),
      events: [{ eventType: 'DEADLINE_AT_RISK', severity: 'low' }],
    });
    expect(deadline.factors.some((f) => f.name === 'event_severity')).toBe(true);
  });

  it('policyVersion 输出（可审计）且同一输入两次计算一致（确定性）', () => {
    const a = compute({ id: 'd1', priority: 'high' });
    const b = compute({ id: 'd1', priority: 'high' });
    expect(a.policyVersion).toBe(policy.version);
    expect(a).toEqual(b);
  });
});

// ============================================================================
// P0-2：事件 scope（eventImpacts）驱动的优先级决策
// ============================================================================

describe('PriorityEngine（Task 下 P0-2：eventImpacts 作用域）', () => {
  const config = defaultConfig();
  const policy = defaultPolicy();
  const now = 0;
  const horizonEndMs = 480 * 60 * 1000;

  function taskRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 't1',
      title: 't1',
      taskType: 'work',
      priority: 'medium',
      status: 'pending',
      assigneeId: null,
      deviceId: null,
      stationId: null,
      zoneId: null,
      planStart: null,
      planEnd: new Date(now + 3600_000).toISOString(),
      progress: 0,
      predecessorIds: [],
      requiredSkills: [],
      requiredCertifications: [],
      ...overrides,
    };
  }

  function resultsFor(snapshot: Parameters<typeof computeEffectivePriorityResults>[2]) {
    return computeEffectivePriorityResults(
      policy,
      config,
      snapshot,
      [],
      now,
      horizonEndMs,
    );
  }

  it('无关安全事件（eventImpacts 仅圈中 other-task）不改变任务优先级', () => {
    const baseline = resultsFor(
      buildSnapshot({ tasks: [taskRow()], events: [], eventImpacts: [] }),
    );
    const irrelevant = resultsFor(
      buildSnapshot({
        tasks: [taskRow()],
        events: [{ eventId: 'evt-x', severity: 'high', status: 'open', eventType: 'DEVICE_OFFLINE' }],
        eventImpacts: [
          {
            eventId: 'evt-x',
            severity: 'high',
            status: 'open',
            affectedTaskIds: ['other-task'],
            affectedPersonIds: [],
            affectedDeviceIds: [],
            affectedStationIds: [],
            affectedZoneIds: [],
          },
        ],
      }),
    );
    expect(irrelevant.get('t1')!.score).toBe(baseline.get('t1')!.score);
    expect(irrelevant.get('t1')!.factors.some((f) => f.name === 'event_severity')).toBe(false);
  });

  it('相关设备事件（eventImpacts.affectedDeviceIds 命中任务设备）→ event_severity 出现、score 更小', () => {
    const baseline = resultsFor(
      buildSnapshot({ tasks: [taskRow()], events: [], eventImpacts: [] }),
    );
    const related = resultsFor(
      buildSnapshot({
        tasks: [taskRow({ deviceId: 'D-1' })],
        events: [{ eventId: 'evt-d', severity: 'high', status: 'open', eventType: 'DEVICE_OFFLINE' }],
        eventImpacts: [
          {
            eventId: 'evt-d',
            severity: 'high',
            status: 'open',
            affectedTaskIds: [],
            affectedPersonIds: [],
            affectedDeviceIds: ['D-1'],
            affectedStationIds: [],
            affectedZoneIds: [],
          },
        ],
      }),
    );
    expect(related.get('t1')!.factors.some((f) => f.name === 'event_severity')).toBe(true);
    expect(related.get('t1')!.score).toBeLessThan(baseline.get('t1')!.score);
  });

  it('L3 安全事件仅影响被圈中的任务，不影响无关任务（scope 正确）', () => {
    const results = resultsFor(
      buildSnapshot({
        tasks: [taskRow({ id: 't-related', deviceId: 'D-1' }), taskRow({ id: 't-unrelated' })],
        events: [{ eventId: 'evt-s', severity: 'critical', status: 'open', eventType: 'SAFETY' }],
        eventImpacts: [
          {
            eventId: 'evt-s',
            severity: 'critical',
            status: 'open',
            affectedTaskIds: [],
            affectedPersonIds: [],
            affectedDeviceIds: ['D-1'],
            affectedStationIds: ['S-1'],
            affectedZoneIds: [],
          },
        ],
      }),
    );
    expect(results.get('t-related')!.factors.some((f) => f.name === 'event_severity')).toBe(true);
    expect(results.get('t-unrelated')!.factors.some((f) => f.name === 'event_severity')).toBe(false);
  });

  it('已解决事件（status !== open）不再影响新计划', () => {
    const baseline = resultsFor(
      buildSnapshot({ tasks: [taskRow()], events: [], eventImpacts: [] }),
    );
    const resolved = resultsFor(
      buildSnapshot({
        tasks: [taskRow({ deviceId: 'D-1' })],
        events: [{ eventId: 'evt-r', severity: 'high', status: 'closed', eventType: 'DEVICE_OFFLINE' }],
        eventImpacts: [
          {
            eventId: 'evt-r',
            severity: 'high',
            status: 'closed',
            affectedTaskIds: [],
            affectedPersonIds: [],
            affectedDeviceIds: ['D-1'],
            affectedStationIds: [],
            affectedZoneIds: [],
          },
        ],
      }),
    );
    expect(resolved.get('t1')!.score).toBe(baseline.get('t1')!.score);
    expect(resolved.get('t1')!.factors.some((f) => f.name === 'event_severity')).toBe(false);
  });

  it('computeEffectivePriorityResults 输出含 rank 与 reasonCodes[]', () => {
    const results = resultsFor(
      buildSnapshot({
        tasks: [
          taskRow({ id: 't-a', priority: 'high' }),
          taskRow({ id: 't-b', priority: 'medium' }),
        ],
        events: [],
        eventImpacts: [],
      }),
    );
    const ra = results.get('t-a')!;
    const rb = results.get('t-b')!;
    // rank 均为 1-based 且互不相同（high 更紧急 → rank 1）。
    expect(ra.rank).toBe(1);
    expect(rb.rank).toBe(2);
    // reasonCodes 已填充且含 base_priority 基线。
    expect(Array.isArray(ra.reasonCodes)).toBe(true);
    expect(ra.reasonCodes).toContain('base_priority');
    expect(rb.reasonCodes).toContain('base_priority');
  });
});