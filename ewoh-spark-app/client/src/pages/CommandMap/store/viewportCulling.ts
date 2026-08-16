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

/**
 * 缩放/平移变换状态（react-zoom-pan-pinch state 子集，纯数据解耦可测）。
 */
export interface PanZoomTransformState {
  scale: number;
  positionX: number;
  positionY: number;
}

/**
 * 由 SVG viewBox + 容器尺寸 + 平移/缩放状态推导当前可视世界范围（NO-13e / ADR-054）。
 *
 * 数学（xMidYMid meet + react-zoom-pan-pinch 内容变换）：
 *   fit = min(containerW / vbW, containerH / vbH)（meet 适配缩放）；
 *   居中偏移 offsetX = (containerW − vbW·fit)/2；
 *   屏幕坐标 → 世界坐标：worldX = (screenX − offsetX − positionX) / (fit·scale) + vb.minX。
 * 非法输入（NaN/非正 scale/零尺寸）→ null（调用方保持默认全量渲染，§33 不猜）。
 */
export function worldBoundsFromTransform(
  transform: PanZoomTransformState | null | undefined,
  container: { width: number; height: number },
  vb: { minX: number; minY: number; w: number; h: number },
): VisibleBounds | null {
  if (!transform) return null;
  if (![transform.scale, transform.positionX, transform.positionY].every(Number.isFinite)) return null;
  if (!(transform.scale > 0)) return null;
  if (![container.width, container.height, vb.minX, vb.minY, vb.w, vb.h].every(Number.isFinite)) return null;
  if (vb.w <= 0 || vb.h <= 0) return null;
  const fit = Math.min(container.width / vb.w, container.height / vb.h);
  const k = fit * transform.scale;
  if (!(k > 0) || !Number.isFinite(k)) return null;
  const offsetX = (container.width - vb.w * fit) / 2;
  const offsetY = (container.height - vb.h * fit) / 2;
  const worldLeft = (0 - offsetX - transform.positionX) / k + vb.minX;
  const worldRight = (container.width - offsetX - transform.positionX) / k + vb.minX;
  const worldTop = (0 - offsetY - transform.positionY) / k + vb.minY;
  const worldBottom = (container.height - offsetY - transform.positionY) / k + vb.minY;
  return makeVisibleBounds(worldLeft, worldTop, worldRight, worldBottom);
}
