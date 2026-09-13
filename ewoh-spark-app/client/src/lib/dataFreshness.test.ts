/* Task 5 / P1：全局 Data Freshness Model 纯函数测试。 */
import {
  classifyFreshness,
  freshnessReason,
  FRESHNESS_LIVE_LAG_MS,
  FRESHNESS_STALE_LAG_MS,
  FRESHNESS_STATUS_PRIORITY,
  type FreshnessInput,
  type FreshnessStatus,
} from './dataFreshness';

const NOW = 1_800_000_000_000;

function input(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return { lastUpdatedAt: null, now: NOW, ...overrides };
}

describe('classifyFreshness：阈值分类', () => {
  it('滞后 <= 5s → LIVE', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 4_000 }))).toBe('LIVE');
    expect(classifyFreshness(input({ lagMs: FRESHNESS_LIVE_LAG_MS }))).toBe('LIVE');
  });

  it('5s < 滞后 <= 30s → DELAYED', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 12_000 }))).toBe('DELAYED');
    expect(classifyFreshness(input({ lagMs: FRESHNESS_STALE_LAG_MS }))).toBe('DELAYED');
  });

  it('滞后 > 30s → STALE', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 31_000 }))).toBe('STALE');
    expect(classifyFreshness(input({ lagMs: FRESHNESS_STALE_LAG_MS + 1 }))).toBe('STALE');
  });

  it('无时间戳且无显式 lag（无新鲜度证据）→ STALE（保守，不宣称 LIVE）', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: null }))).toBe('STALE');
  });

  it('lagMs 优先于 lastUpdatedAt 计算', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, lagMs: 60_000 }))).toBe('STALE');
  });

  it.each([NaN, Infinity, -Infinity, NOW + 1])(
    '无效或未来时间戳 %p → STALE（不误报 LIVE）',
    (lastUpdatedAt) => {
      expect(classifyFreshness(input({ lastUpdatedAt }))).toBe('STALE');
    },
  );
});

describe('classifyFreshness：SSE 断开不得误报 LIVE（关键规则）', () => {
  it('connectionState=OFFLINE 但缓存时间戳很新 → OFFLINE（绝不 LIVE）', () => {
    expect(
      classifyFreshness(input({ lastUpdatedAt: NOW - 500, connectionState: 'OFFLINE' })),
    ).toBe('OFFLINE');
  });

  it('connected=false 但缓存时间戳很新 → OFFLINE（绝不 LIVE）', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 500, connected: false }))).toBe('OFFLINE');
  });

  it('OFFLINE 优先级高于 REPLAY/SHADOW 之外的任何滞后分类', () => {
    expect(
      classifyFreshness(input({ lastUpdatedAt: NOW - 100, connectionState: 'OFFLINE', connected: false })),
    ).toBe('OFFLINE');
  });
});

describe('classifyFreshness：REPLAY / SHADOW 优先', () => {
  it('replayActive → REPLAY（即使连接断开）', () => {
    expect(
      classifyFreshness(input({ lastUpdatedAt: NOW - 500, connectionState: 'OFFLINE', replayActive: true })),
    ).toBe('REPLAY');
  });

  it('shadowMode → SHADOW', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 500, shadowMode: true }))).toBe('SHADOW');
  });

  it('replay 优先于 shadow', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 500, replayActive: true, shadowMode: true }))).toBe('REPLAY');
  });
});

describe('classifyFreshness：连接态细节（V2 词汇统一为一级状态）', () => {
  it('DEGRADED（轮询兜底）→ DEGRADED（一级状态，不再按滞后分类）', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, connectionState: 'DEGRADED' }))).toBe('DEGRADED');
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 12_000, connectionState: 'DEGRADED' }))).toBe('DEGRADED');
  });

  it('RESYNCING（全量重同步）→ RESYNCING（一级状态）', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, connectionState: 'RESYNCING' }))).toBe('RESYNCING');
  });

  it('CONNECTED + 新时间戳 → LIVE', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, connectionState: 'CONNECTED', connected: true }))).toBe('LIVE');
  });

  it('RESYNCING/DEGRADED 优先级低于 OFFLINE（断开判定优先）', () => {
    expect(
      classifyFreshness(input({ lastUpdatedAt: NOW - 500, connectionState: 'RESYNCING', connected: false })),
    ).toBe('OFFLINE');
    expect(
      classifyFreshness(input({ lastUpdatedAt: NOW - 500, connectionState: 'DEGRADED', connected: false })),
    ).toBe('OFFLINE');
  });

  it('RESYNCING 优先级高于 DEGRADED（互斥场景取更严重者）', () => {
    expect(classifyFreshness(input({ connectionState: 'RESYNCING' }))).toBe('RESYNCING');
  });

  it('REPLAY 仍为最高优先级（覆盖 RESYNCING/DEGRADED）', () => {
    expect(
      classifyFreshness(input({ connectionState: 'RESYNCING', replayActive: true })),
    ).toBe('REPLAY');
  });

  it('SHADOW 优先级高于 RESYNCING/DEGRADED', () => {
    expect(
      classifyFreshness(input({ connectionState: 'DEGRADED', shadowMode: true })),
    ).toBe('SHADOW');
  });
});

describe('FRESHNESS_STATUS_PRIORITY：REPLAY 恒为最高，LIVE 最低', () => {
  it('优先级排序（REPLAY > OFFLINE > RESYNCING > DEGRADED > SHADOW > STALE > DELAYED > LIVE）', () => {
    const sorted = (Object.keys(FRESHNESS_STATUS_PRIORITY) as FreshnessStatus[]).sort(
      (a, b) => FRESHNESS_STATUS_PRIORITY[a] - FRESHNESS_STATUS_PRIORITY[b],
    );
    expect(sorted).toEqual([
      'LIVE',
      'DELAYED',
      'STALE',
      'SHADOW',
      'DEGRADED',
      'RESYNCING',
      'OFFLINE',
      'REPLAY',
    ]);
  });

  it('REPLAY 优先级最高且无并列', () => {
    const values = Object.values(FRESHNESS_STATUS_PRIORITY);
    expect(new Set(values).size).toBe(values.length);
    expect(Math.max(...values)).toBe(FRESHNESS_STATUS_PRIORITY.REPLAY);
  });
});

describe('freshnessReason：tooltip 人读原因', () => {
  it('断开时说明「缓存数据不得视为实时」', () => {
    expect(freshnessReason(input({ lastUpdatedAt: NOW - 500, connectionState: 'OFFLINE' }))).toContain('不得视为实时');
  });

  it('LIVE 时给出滞后读数', () => {
    expect(freshnessReason(input({ lastUpdatedAt: NOW - 1_000 }))).toContain('滞后 1s');
  });

  it('STALE 时给出阈值说明', () => {
    expect(freshnessReason(input({ lastUpdatedAt: NOW - 60_000 }))).toContain('过期');
  });

  it('无证据时说明保守标记', () => {
    expect(freshnessReason(input({ lastUpdatedAt: null }))).toContain('无新鲜度证据');
  });

  it('RESYNCING 时说明正在全量重同步', () => {
    expect(freshnessReason(input({ connectionState: 'RESYNCING' }))).toContain('重同步');
  });

  it('DEGRADED 时说明轮询兜底', () => {
    expect(freshnessReason(input({ connectionState: 'DEGRADED' }))).toContain('降级');
  });
});
