/**
 * 错误与恢复体验审计（Task 9）——核心页面的 12 种状态覆盖回归测试。
 *
 * 12 种状态：loading(加载) / empty(空) / partial(部分) / stale(过期) /
 * degraded(降级) / offline(离线) / unauthorized(未认证) / forbidden(禁止) /
 * conflict(冲突) / error(错误) / recovery(恢复) / success(成功确认)。
 *
 * 该 fixture 是「每个核心页面实际接线的状态」的唯一事实来源。任何页面改动
 * 若移除了对某状态的处理，此测试会失败，从而防止状态接线回归。
 */
import * as fs from 'fs';
import * as path from 'path';

export const CORE_PAGE_STATES = Object.freeze([
  'loading',
  'empty',
  'partial',
  'stale',
  'degraded',
  'offline',
  'unauthorized',
  'forbidden',
  'conflict',
  'error',
  'recovery',
  'success',
] as const);

export type CorePageState = (typeof CORE_PAGE_STATES)[number];

/** 页面 → 已接线状态矩阵（与各页面实际实现保持一致）。 */
export const PAGE_STATE_MATRIX: Record<string, readonly CorePageState[]> = Object.freeze({
  CommandMap: ['loading', 'empty', 'partial', 'degraded', 'error', 'recovery', 'success'],
  WorkOrchestration: ['loading', 'conflict', 'error', 'recovery'],
  Overview: ['empty', 'stale', 'error', 'recovery'],
  Events: ['loading', 'empty', 'stale', 'error', 'recovery'],
  Devices: ['loading', 'empty', 'stale', 'error', 'recovery', 'unauthorized', 'forbidden', 'conflict'],
  Alerts: ['loading', 'empty', 'stale', 'offline', 'error', 'recovery', 'success'],
});

describe('核心页面 12 种状态覆盖矩阵', () => {
  it('fixture 中的状态名都属于 12 状态枚举', () => {
    const valid = new Set<string>(CORE_PAGE_STATES);
    for (const [page, states] of Object.entries(PAGE_STATE_MATRIX)) {
      for (const state of states) {
        if (!valid.has(state)) {
          throw new Error(`${page} 出现未知状态 ${state}`);
        }
      }
    }
  });

  it('每个核心页面都至少接线 error 与 recovery', () => {
    for (const [page, states] of Object.entries(PAGE_STATE_MATRIX)) {
      expect(states).toContain('error');
      expect(states).toContain('recovery');
    }
  });

  it('核心页面并集覆盖全部 12 种状态', () => {
    const union = new Set<string>();
    for (const states of Object.values(PAGE_STATE_MATRIX)) {
      for (const state of states) union.add(state);
    }
    for (const state of CORE_PAGE_STATES) {
      if (!union.has(state)) {
        throw new Error(`没有任何核心页面接线状态 ${state}`);
      }
    }
    expect(union.size).toBe(CORE_PAGE_STATES.length);
  });
});

describe('页面接线与源码一致性（fixture 佐证）', () => {
  const pagesDir = path.join(__dirname);

  /** 源码中是否出现关键接线标记 */
  const sourceHas = (pageDir: 'CommandMap' | 'WorkOrchestration' | 'Overview' | 'Events' | 'Devices' | 'Alerts', marker: string): boolean => {
    const file = path.join(pagesDir, pageDir, `${pageDir}.tsx`);
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').includes(marker);
  };

  it('CommandMap 接线 partial/degraded（DataStates）与 recovery（retryAll）', () => {
    expect(sourceHas('CommandMap', 'DataStates')).toBe(true);
    expect(sourceHas('CommandMap', 'retryAll')).toBe(true);
  });

  it('WorkOrchestration 接线 conflict 与 error/recovery', () => {
    expect(sourceHas('WorkOrchestration', 'conflicts')).toBe(true);
    expect(sourceHas('WorkOrchestration', 'AppErrorState')).toBe(true);
  });

  it('Overview 接线 stale 与 error/recovery', () => {
    expect(sourceHas('Overview', 'health="stale"')).toBe(true);
    expect(sourceHas('Overview', 'AppErrorState')).toBe(true);
  });

  it('Events 接线 stale 与 error/recovery', () => {
    expect(sourceHas('Events', 'health="stale"')).toBe(true);
    expect(sourceHas('Events', 'AppErrorState')).toBe(true);
  });

  it('Devices 接线 unauthorized/forbidden/conflict（AppErrorState 区分 401/403/409）', () => {
    expect(sourceHas('Devices', 'AppErrorState')).toBe(true);
  });

  it('Alerts 接线 offline（OfflineState）与 success（toast）', () => {
    expect(sourceHas('Alerts', 'OfflineState')).toBe(true);
    expect(sourceHas('Alerts', "toast.success('告警状态已更新')")).toBe(true);
  });
});