import {
  clampEventWindowHours,
  clampListLimit,
  clampListOffset,
  DEFAULT_EVENT_WINDOW_HOURS,
  MAX_EVENT_WINDOW_HOURS,
  MAX_LIST_LIMIT,
} from './query-params';

describe('clampListLimit', () => {
  it('缺省值走 fallback', () => {
    expect(clampListLimit(undefined, 50)).toBe(50);
    expect(clampListLimit(undefined, 200)).toBe(200);
    expect(clampListLimit(undefined, 100)).toBe(100);
  });

  it('区间内取值保持不变（含小数截断）', () => {
    expect(clampListLimit(20, 50)).toBe(20);
    expect(clampListLimit(1, 50)).toBe(1);
    expect(clampListLimit(499, 50)).toBe(499);
    // 小数向零截断，与历史 Math.trunc 语义一致
    expect(clampListLimit(20.9, 50)).toBe(20);
  });

  it('下限 1：0 与负数被抬到 1', () => {
    expect(clampListLimit(0, 50)).toBe(1);
    expect(clampListLimit(-5, 50)).toBe(1);
  });

  it('上限 500：超限被截到 MAX_LIST_LIMIT', () => {
    expect(clampListLimit(1e9, 50)).toBe(MAX_LIST_LIMIT);
    expect(clampListLimit(501, 50)).toBe(MAX_LIST_LIMIT);
  });

  it('支持自定义上限', () => {
    expect(clampListLimit(300, 20, 100)).toBe(100);
    expect(clampListLimit(50, 20, 100)).toBe(50);
  });

  // ---- 以下用例锁定"与历史实现等价"的病态输入行为，改动即破坏契约 ----
  // 这些值在当前调用链上不可达（controller 已 Number.isFinite 过滤），
  // 但一旦有人"顺手修正" NaN 行为，本组用例会失败并暴露语义分叉。
  it('NaN 按历史语义透传（不由本模块兜底）', () => {
    expect(clampListLimit(Number.NaN, 50)).toBeNaN();
  });

  it('±Infinity 按历史语义被 clamp', () => {
    expect(clampListLimit(Number.POSITIVE_INFINITY, 50)).toBe(MAX_LIST_LIMIT);
    expect(clampListLimit(Number.NEGATIVE_INFINITY, 50)).toBe(1);
  });
});

describe('clampListOffset', () => {
  it('缺省回退 0', () => {
    expect(clampListOffset(undefined)).toBe(0);
  });

  it('保持合法值并截断小数', () => {
    expect(clampListOffset(0)).toBe(0);
    expect(clampListOffset(40)).toBe(40);
    expect(clampListOffset(40.9)).toBe(40);
  });

  it('负数抬到 0', () => {
    expect(clampListOffset(-1)).toBe(0);
    expect(clampListOffset(-999)).toBe(0);
  });

  it('病态输入按历史语义透传（契约锁定）', () => {
    expect(clampListOffset(Number.NaN)).toBeNaN();
    expect(clampListOffset(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('clampEventWindowHours', () => {
  it('缺省 24h', () => {
    expect(clampEventWindowHours(undefined)).toBe(DEFAULT_EVENT_WINDOW_HOURS);
    expect(clampEventWindowHours(undefined)).toBe(24);
    expect(clampEventWindowHours(Number.NaN)).toBe(24);
  });

  it('区间内保持并截断小数', () => {
    expect(clampEventWindowHours(1)).toBe(1);
    expect(clampEventWindowHours(48)).toBe(48);
    expect(clampEventWindowHours(12.7)).toBe(12);
  });

  it('clamp 到 [1, 168]', () => {
    expect(clampEventWindowHours(0)).toBe(1);
    expect(clampEventWindowHours(-5)).toBe(1);
    expect(clampEventWindowHours(1000)).toBe(MAX_EVENT_WINDOW_HOURS);
    expect(clampEventWindowHours(1000)).toBe(168);
  });

  it('支持自定义 fallback', () => {
    expect(clampEventWindowHours(undefined, 6)).toBe(6);
  });

  it('±Infinity 按历史语义回退缺省（该函数以 isFinite 为准，与 limit/offset 不同）', () => {
    // 注意与 clampListLimit 的差异：本函数历史实现用 `Number.isFinite` 判定，
    // 故 ±Infinity 走 fallback 分支；而 clampListLimit 用 `??`，Infinity 会被 clamp。
    // 此差异由穷举差分验证锁定，不可"顺手统一"。
    expect(clampEventWindowHours(Number.POSITIVE_INFINITY)).toBe(24);
    expect(clampEventWindowHours(Number.NEGATIVE_INFINITY)).toBe(24);
  });
});
