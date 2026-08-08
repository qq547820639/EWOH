import { PriorityEngine } from '../priority-engine';
import { defaultConfig, defaultPolicy } from './scheduler-test-helpers';

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
});