/// <reference types="jest" />
/* NO-92a：SOC 合理性闸门纯函数域规则单测。
 *
 * 判据语义见 shared/soc-plausibility.ts 头注（领域口径是唯一事实源）。
 * 这里钉死：越界/无锚/锚过期的如实语义、包络边界（floor 与速率×dt 的 max）、
 * 负 dt 钳制、配置解析的非法回退、连击追踪的有界性与重置语义。
 */
import {
  evaluateSocPlausibility,
  resolveSocPlausibilityConfig,
  SocReanchorTracker,
  SOC_PLAUSIBILITY_DEFAULTS,
  SOC_OUT_OF_RANGE,
  SOC_JUMP_IMPLAUSIBLE,
  socRejectionMessage,
  type SocPlausibilityConfig,
} from '@shared/soc-plausibility';

const CFG: SocPlausibilityConfig = { ...SOC_PLAUSIBILITY_DEFAULTS };
const T0 = new Date('2026-09-18T08:00:00Z');

function at(minutesLater: number): Date {
  return new Date(T0.getTime() + minutesLater * 60000);
}

describe('evaluateSocPlausibility', () => {
  it('越界（>100 / <0 / NaN）无条件拒绝，无需锚点', () => {
    for (const bad of [150, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = evaluateSocPlausibility({
        prevPct: 50, prevAt: T0, candidate: bad, candidateAt: at(1), cfg: CFG,
      });
      expect(v.verdict).toBe('out_of_range');
      expect(socRejectionMessage(v as never, bad, 50)).toContain(SOC_OUT_OF_RANGE);
    }
  });

  it('无锚点（首帧）→ unjudgeable 如实接受', () => {
    const v = evaluateSocPlausibility({
      prevPct: null, prevAt: null, candidate: 95, candidateAt: at(0), cfg: CFG,
    });
    expect(v).toEqual({ verdict: 'unjudgeable', reason: 'no_anchor' });
  });

  it('锚点过期（dt > dtCap）→ unjudgeable（不拿过期锚拒绝真实状态）', () => {
    const v = evaluateSocPlausibility({
      prevPct: 8, prevAt: T0, candidate: 95, candidateAt: at(CFG.dtCapMin + 1), cfg: CFG,
    });
    expect(v).toEqual({ verdict: 'unjudgeable', reason: 'stale_anchor' });
  });

  it('量化噪声：dt 极短时 |Δ| ≤ floor 判为合理', () => {
    const v = evaluateSocPlausibility({
      prevPct: 90, prevAt: T0, candidate: 88, candidateAt: at(1 / 60), cfg: CFG,
    });
    expect(v.verdict).toBe('plausible');
  });

  it('速率包络边界：Δ 恰好 = max(floor, rate×dt) 判合理（含浮点容差）', () => {
    // rate 1.5/min × 30min = 45 点包络 → 90→46（Δ=44）合理，90→44（Δ=46）拒绝
    const ok = evaluateSocPlausibility({
      prevPct: 90, prevAt: T0, candidate: 46, candidateAt: at(30), cfg: CFG,
    });
    expect(ok.verdict).toBe('plausible');
    const rejected = evaluateSocPlausibility({
      prevPct: 90, prevAt: T0, candidate: 44, candidateAt: at(30), cfg: CFG,
    });
    expect(rejected.verdict).toBe('implausible');
  });

  it('单帧坏传感回跳：8→95（dt=1.2s）远超包络 → 拒绝且回显判据数值', () => {
    const v = evaluateSocPlausibility({
      prevPct: 8, prevAt: T0, candidate: 95, candidateAt: at(1.2 / 60), cfg: CFG,
    });
    expect(v.verdict).toBe('implausible');
    if (v.verdict === 'implausible') {
      expect(v.maxDelta).toBeCloseTo(CFG.jumpFloorPts, 5);
      const msg = socRejectionMessage(v, 95, 8);
      expect(msg).toContain(SOC_JUMP_IMPLAUSIBLE);
      expect(msg).toContain('8→95');
    }
  });

  it('负 dt（乱序迟到帧）钳到 0，只按噪声下限判', () => {
    const v = evaluateSocPlausibility({
      prevPct: 8, prevAt: at(10), candidate: 95, candidateAt: T0, cfg: CFG,
    });
    expect(v.verdict).toBe('implausible');
    if (v.verdict === 'implausible') {
      expect(v.dtMin).toBe(0);
      expect(v.maxDelta).toBeCloseTo(CFG.jumpFloorPts, 5);
    }
  });

  it('真实充电增量跟踪：长窗内上升在包络内判合理（连续曲线逐帧刷新锚点）', () => {
    // 1.5%/min × 29min = 43.5 点包络 → 8→48（Δ=40）是合法充电增量；
    // 超过锚点时效的整段跳变不走包络（unjudgeable），由再锚定连击兜底。
    const v = evaluateSocPlausibility({
      prevPct: 8, prevAt: T0, candidate: 48, candidateAt: at(29), cfg: CFG,
    });
    expect(v.verdict).toBe('plausible');
  });
});

describe('resolveSocPlausibilityConfig', () => {
  it('无环境变量 → 全默认', () => {
    const { cfg, sources } = resolveSocPlausibilityConfig({});
    expect(cfg).toEqual(SOC_PLAUSIBILITY_DEFAULTS);
    expect(Object.values(sources).every((s) => s === 'default')).toBe(true);
  });

  it('合法环境变量覆盖对应项并标记 env 来源', () => {
    const { cfg, sources } = resolveSocPlausibilityConfig({
      EWOH_SOC_MAX_RATE_PER_MIN: '3',
      EWOH_SOC_JUMP_FLOOR_PTS: '2',
      EWOH_SOC_DT_CAP_MIN: '60',
      EWOH_SOC_REANCHOR_STREAK: '5',
    });
    expect(cfg).toEqual({ maxRatePerMin: 3, jumpFloorPts: 2, dtCapMin: 60, reanchorStreak: 5 });
    expect(Object.values(sources).every((s) => s === 'env')).toBe(true);
  });

  it('非法值（非数/负数/小数连击）逐项回退默认', () => {
    const { cfg, sources } = resolveSocPlausibilityConfig({
      EWOH_SOC_MAX_RATE_PER_MIN: 'abc',
      EWOH_SOC_JUMP_FLOOR_PTS: '-1',
      EWOH_SOC_DT_CAP_MIN: '',
      EWOH_SOC_REANCHOR_STREAK: '2.5',
    });
    expect(cfg).toEqual(SOC_PLAUSIBILITY_DEFAULTS);
    expect(Object.values(sources).every((s) => s === 'default')).toBe(true);
  });
});

describe('SocReanchorTracker', () => {
  it('同水平连击递增，换水平重置为 1', () => {
    const t = new SocReanchorTracker(100, (() => { let n = 0; return () => ++n; })());
    expect(t.record('org:d1', 95)).toBe(1);
    expect(t.record('org:d1', 95)).toBe(2);
    expect(t.record('org:d1', 96)).toBe(1);
    expect(t.currentStreak('org:d1')).toBe(1);
  });

  it('clear 清除连击（可信锚点成立即作废旧争议）', () => {
    const t = new SocReanchorTracker(100);
    t.record('org:d1', 95);
    t.record('org:d1', 95);
    t.clear('org:d1');
    expect(t.currentStreak('org:d1')).toBe(0);
    expect(t.record('org:d1', 95)).toBe(1);
  });

  it('按 (org, device) 键隔离', () => {
    const t = new SocReanchorTracker(100);
    t.record('org:d1', 95);
    expect(t.currentStreak('org:d2')).toBe(0);
    expect(t.record('org:d2', 95)).toBe(1);
  });

  it('有界：超容淘汰最老一半，不无限增长', () => {
    let clock = 0;
    const t = new SocReanchorTracker(4, () => ++clock);
    for (let i = 0; i < 10; i++) t.record(`k${i}`, 50);
    expect(t.currentStreak('k0')).toBe(0);
    expect(t.currentStreak('k9')).toBe(1);
  });
});
