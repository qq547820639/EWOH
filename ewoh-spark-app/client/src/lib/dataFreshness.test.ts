/* Task 5 / P1：全局 Data Freshness Model 纯函数测试。 */
import {
  classifyFreshness,
  freshnessReason,
  FRESHNESS_LIVE_LAG_MS,
  FRESHNESS_STALE_LAG_MS,
  type FreshnessInput,
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

describe('classifyFreshness：连接态细节', () => {
  it('DEGRADED（轮询兜底）仍按滞后分类', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, connectionState: 'DEGRADED' }))).toBe('LIVE');
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 12_000, connectionState: 'DEGRADED' }))).toBe('DELAYED');
  });

  it('RESYNCING 视为已连接，按滞后分类', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, connectionState: 'RESYNCING' }))).toBe('LIVE');
  });

  it('CONNECTED + 新时间戳 → LIVE', () => {
    expect(classifyFreshness(input({ lastUpdatedAt: NOW - 1_000, connectionState: 'CONNECTED', connected: true }))).toBe('LIVE');
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
});
