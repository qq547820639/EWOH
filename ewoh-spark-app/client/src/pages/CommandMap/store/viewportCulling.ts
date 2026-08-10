/* Task 4 / P1：视口 culling 纯函数（无 React 依赖，node 可测）。
 *
 * FactoryMap 在 visibleBounds 非空时按世界坐标（工厂坐标系）剔除视野外实体，
 * bounds 为 null 时保持默认行为（渲染全部）。工厂坐标系与 SVG viewBox 同源，
 * 故直接用实体 x/y 与 bounds 比较即可。
 */

export interface VisibleBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CullablePoint {
  x: number;
  y: number;
}

/** 点是否落在 bounds 内（padding 单位为世界坐标，用于保留跨边界大图形的边缘）。 */
export function isPointWithinBounds(
  point: CullablePoint,
  bounds: VisibleBounds,
  padding = 0,
): boolean {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

/**
 * 按可见范围剔除实体列表；bounds 为 null/undefined 时原样返回（默认行为）。
 * 返回新数组（纯函数，不修改入参）。
 */
export function cullByBounds<T extends CullablePoint>(
  items: T[],
  bounds: VisibleBounds | null | undefined,
  padding = 0,
): T[] {
  if (!bounds) return items;
  return items.filter((item) => isPointWithinBounds(item, bounds, padding));
}

/** 由 min/max 构造 bounds（保证 min <= max，NaN 安全）。 */
export function makeVisibleBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): VisibleBounds | null {
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return {
    minX: Math.min(minX, maxX),
    minY: Math.min(minY, maxY),
    maxX: Math.max(minX, maxX),
    maxY: Math.max(minY, maxY),
  };
}

/** 带几何尺寸的实体（用于静态大图形：跨边界时按尺寸给 padding）。 */
export interface BoundedCullable extends CullablePoint {
  bboxW?: number;
  bboxH?: number;
}

/** 实体 padding：取 bbox 半长边，保证跨边界大图形边缘不被错误剔除。 */
export function cullPaddingFor(item: BoundedCullable): number {
  const w = Math.abs(item.bboxW ?? 0);
  const h = Math.abs(item.bboxH ?? 0);
  return Math.max(w, h) / 2;
}
