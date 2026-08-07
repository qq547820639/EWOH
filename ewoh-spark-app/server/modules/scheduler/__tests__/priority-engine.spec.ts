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
});