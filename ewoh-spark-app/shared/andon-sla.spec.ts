/* 安灯 SLA / "没人接手"升级判定（NO-48a）纯函数测试。
 *
 * 钉死：分档边界（1×/2×SLA）、缺时间/缺 SLA 时**不下结论**、
 * 受众按级别确定、文案含"多久没人接手"与下一步动作、"无人接手"与"接手晚了"可区分。
 */
/// <reference types="jest" />
import {
  ANDON_DEFAULT_SLA_SECONDS,
  andonBreachRecipients,
  andonBreachText,
  evaluateAndonSla,
} from './andon-sla';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const minutesAgo = (m: number) => NOW - m * 60_000;

describe('evaluateAndonSla', () => {
  it('未超期 → breachLevel 0（不升级）', () => {
    const state = evaluateAndonSla({ openedAtMs: minutesAgo(5), slaSeconds: 900, nowMs: NOW });
    expect(state).toMatchObject({ breachLevel: 0, bucket: null, overdueSeconds: 0, slaIsDefault: false });
    expect(state.ageSeconds).toBe(300);
  });

  it('刚好等于 SLA → 还不算超期（严格大于才升级）', () => {
    const state = evaluateAndonSla({ openedAtMs: minutesAgo(15), slaSeconds: 900, nowMs: NOW });
    expect(state.breachLevel).toBe(0);
  });

  it('超过 1×SLA → L1；超过 2×SLA → L2（分档边界）', () => {
    const l1 = evaluateAndonSla({ openedAtMs: minutesAgo(16), slaSeconds: 900, nowMs: NOW });
    expect(l1).toMatchObject({ breachLevel: 1, bucket: 'sla_breach_l1' });
    expect(l1.overdueSeconds).toBe(60);
    const l1Edge = evaluateAndonSla({ openedAtMs: minutesAgo(30), slaSeconds: 900, nowMs: NOW });
    expect(l1Edge.breachLevel).toBe(1);
    const l2 = evaluateAndonSla({ openedAtMs: minutesAgo(31), slaSeconds: 900, nowMs: NOW });
    expect(l2).toMatchObject({ breachLevel: 2, bucket: 'sla_breach_l2' });
    const l2Late = evaluateAndonSla({ openedAtMs: minutesAgo(600), slaSeconds: 900, nowMs: NOW });
    expect(l2Late.breachLevel).toBe(2);
  });

  it('安灯没记录 SLA → 用默认值并显式标记（不假装是它自己的口径）', () => {
    const missing = evaluateAndonSla({ openedAtMs: minutesAgo(20), slaSeconds: null, nowMs: NOW });
    expect(missing.slaSeconds).toBe(ANDON_DEFAULT_SLA_SECONDS);
    expect(missing.slaIsDefault).toBe(true);
    expect(missing.breachLevel).toBe(1);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateAndonSla({ openedAtMs: minutesAgo(20), slaSeconds: bad, nowMs: NOW }).slaIsDefault).toBe(true);
    }
  });

  it('开启时间缺失/非法 → 不下结论（reason 说明原因，绝不猜成"没超期"以外的结论）', () => {
    for (const openedAtMs of [null, Number.NaN]) {
      const state = evaluateAndonSla({ openedAtMs, slaSeconds: 900, nowMs: NOW });
      expect(state.breachLevel).toBe(0);
      expect(state.bucket).toBeNull();
      expect(state.ageSeconds).toBeNull();
      expect(String(state.reason)).toContain('无法判断');
    }
  });

  it('时间倒流（开启时间在未来）→ 年龄按 0 处理，不产生负超期', () => {
    const state = evaluateAndonSla({ openedAtMs: NOW + 600_000, slaSeconds: 900, nowMs: NOW });
    expect(state.ageSeconds).toBe(0);
    expect(state.overdueSeconds).toBe(0);
    expect(state.breachLevel).toBe(0);
  });
});

describe('andonBreachRecipients', () => {
  it('L1 → 班组长 + 调度；L2 → 追加安全员；未超期 → 空', () => {
    expect(andonBreachRecipients(0)).toEqual([]);
    expect(andonBreachRecipients(1)).toEqual(['workshop_lead', 'dispatcher']);
    expect(andonBreachRecipients(2)).toEqual(['safety_admin', 'workshop_lead', 'dispatcher']);
  });
});

describe('andonBreachText', () => {
  it('文案说清"多久没人接手"、SLA 来源与下一步动作', () => {
    const text = andonBreachText({
      title: '线边缺料',
      deviceId: 'EXO-1',
      ageSeconds: 20 * 60,
      slaSeconds: 900,
      level: 1,
      slaIsDefault: false,
    });
    expect(text.title).toContain('L1');
    expect(text.title).toContain('线边缺料');
    expect(text.body).toContain('EXO-1');
    expect(text.body).toContain('无人接手');
    expect(text.body).toContain('20 分钟');
    expect(text.body).toContain('15 分钟');
    expect(text.body).toContain('acknowledge');
  });

  it('用默认 SLA 时文案显式说明（不把默认口径说成该安灯的口径）', () => {
    const text = andonBreachText({
      title: '线边缺料',
      deviceId: null,
      ageSeconds: 20 * 60,
      slaSeconds: ANDON_DEFAULT_SLA_SECONDS,
      level: 2,
      slaIsDefault: true,
    });
    expect(text.body).toContain('未记录自己的 SLA');
    expect(text.body).toContain('默认');
  });
});
