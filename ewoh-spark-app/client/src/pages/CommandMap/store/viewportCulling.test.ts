/* Task 4 / P1：视口 culling 纯函数测试（node 环境）。 */
import {
  cullByBounds,
  isPointWithinBounds,
  makeVisibleBounds,
  cullPaddingFor,
  type VisibleBounds,
} from './viewportCulling';

const BOUNDS: VisibleBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe('isPointWithinBounds', () => {
  it('界内/边界点 → true，界外 → false', () => {
    expect(isPointWithinBounds({ x: 50, y: 50 }, BOUNDS)).toBe(true);
    expect(isPointWithinBounds({ x: 0, y: 0 }, BOUNDS)).toBe(true); // 边界含
    expect(isPointWithinBounds({ x: 100, y: 100 }, BOUNDS)).toBe(true);
    expect(isPointWithinBounds({ x: 101, y: 50 }, BOUNDS)).toBe(false);
    expect(isPointWithinBounds({ x: 50, y: -1 }, BOUNDS)).toBe(false);
  });

  it('padding 扩展可见范围（跨边界大图形边缘保留）', () => {
    expect(isPointWithinBounds({ x: 110, y: 50 }, BOUNDS, 20)).toBe(true);
    expect(isPointWithinBounds({ x: 110, y: 50 }, BOUNDS)).toBe(false);
  });
});

describe('cullByBounds', () => {
  const items = [
    { entityId: 'a', x: 10, y: 10 },
    { entityId: 'b', x: 200, y: 200 },
    { entityId: 'c', x: 50, y: 60 },
  ];

  it('bounds 非空 → 只返回界内实体（不修改入参）', () => {
    const result = cullByBounds(items, BOUNDS);
    expect(result.map((i) => i.entityId)).toEqual(['a', 'c']);
    expect(items).toHaveLength(3); // 原数组不变
  });

  it('bounds 为 null/undefined → 原样返回全部（默认行为）', () => {
    expect(cullByBounds(items, null)).toBe(items);
    expect(cullByBounds(items, undefined)).toBe(items);
  });

  it('空列表安全', () => {
    expect(cullByBounds([], BOUNDS)).toEqual([]);
  });
});

describe('makeVisibleBounds', () => {
  it('归一化 min/max（乱序输入）', () => {
    expect(makeVisibleBounds(100, 100, 0, 0)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it('NaN/Infinity → null（安全降级，不产生无效 bounds）', () => {
    expect(makeVisibleBounds(NaN, 0, 10, 10)).toBeNull();
    expect(makeVisibleBounds(0, 0, Infinity, 10)).toBeNull();
  });
});

describe('cullPaddingFor', () => {
  it('取 bbox 半长边作为 padding（大图形跨边界不被误删）', () => {
    expect(cullPaddingFor({ x: 0, y: 0, bboxW: 100, bboxH: 40 })).toBe(50);
    expect(cullPaddingFor({ x: 0, y: 0 })).toBe(0);
  });
});
