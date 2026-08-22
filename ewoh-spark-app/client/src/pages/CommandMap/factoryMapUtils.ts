/* CLI-010 拆分：FactoryMap 图层渲染函数/视口工具（机械提取，行为不变）。
 *
 * 纯函数零 React 依赖：ETA 格式化、摄像头视锥、静态样式、人员/设备
 * 位置合并、自适应 viewBox。FactoryMap.tsx 仅保留编排与 SVG 图层 JSX。
 */
import type {
  CurrentWorldState,
  SpatialEntity,
} from '@shared/api.interface';

/** P0：ETA 格式化（后端秒 → 分:秒 / 分钟）；缺失返回空串（不前端估算）。 */
export function formatEta(etaSeconds: number): string {
  if (!Number.isFinite(etaSeconds) || etaSeconds < 0) return '';
  const total = Math.round(etaSeconds);
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec > 0 ? `${min}m${sec}s` : `${min}m`;
}

/** 摄像头视锥三角形顶点（yaw=0 朝右，按 yaw 旋转） */
export function cameraFovPoints(
  x: number,
  y: number,
  yaw: number,
  fovDeg: number,
  range: number,
): string {
  const yawRad = (yaw * Math.PI) / 180;
  const halfFov = (fovDeg * Math.PI) / 360;
  const p1x = x + range * Math.cos(yawRad - halfFov);
  const p1y = y + range * Math.sin(yawRad - halfFov);
  const p2x = x + range * Math.cos(yawRad + halfFov);
  const p2y = y + range * Math.sin(yawRad + halfFov);
  return `${x},${y} ${p1x},${p1y} ${p2x},${p2y}`;
}

export interface StaticStyle {
  fill: string;
  stroke: string;
  dash?: string;
}

export function getStaticStyle(type: string): StaticStyle {
  switch (type) {
    case 'workshop':
      return { fill: 'rgba(59,130,246,0.15)', stroke: 'rgba(59,130,246,0.5)' };
    case 'production_line':
      return { fill: 'rgba(168,85,247,0.10)', stroke: 'rgba(168,85,247,0.4)' };
    case 'route':
      return { fill: 'rgba(148,163,184,0.06)', stroke: 'rgba(148,163,184,0.3)' };
    // 通道（corridor，2026-08-20）：青绿色带状走廊 + 虚线描边——与车间蓝/
    // 产线紫明确区分，肉眼可辨；dash 虚线呼应"通行语义"。
    case 'corridor':
      return { fill: 'rgba(45,212,191,0.16)', stroke: 'rgba(45,212,191,0.65)', dash: '6 4' };
    case 'restricted_zone':
      return { fill: 'rgba(239,68,68,0.12)', stroke: 'rgba(239,68,68,0.6)', dash: '4 4' };
    case 'zone':
    default:
      return { fill: 'rgba(59,130,246,0.08)', stroke: 'rgba(59,130,246,0.4)' };
  }
}

/** 合并 worldState 与静态 entities 的人员/设备位置 */
export interface DynPoint {
  entityId: string;
  name: string;
  x: number;
  y: number;
  status: string;
  loadScore?: number;
  deviceId?: string;
  workerId?: string;
}

export function mergePersons(
  entities: SpatialEntity[],
  worldState: CurrentWorldState | null,
): DynPoint[] {
  const map = new Map<string, DynPoint>();
  if (worldState) {
    for (const p of worldState.persons) {
      map.set(p.entityId, {
        entityId: p.entityId,
        name: p.name,
        x: p.x,
        y: p.y,
        status: p.status,
        loadScore: p.loadScore,
        deviceId: p.deviceId,
      });
    }
  }
  for (const e of entities) {
    if (e.entityType !== 'person') continue;
    if (map.has(e.entityId)) continue;
    map.set(e.entityId, {
      entityId: e.entityId,
      name: e.name,
      x: e.x,
      y: e.y,
      status: e.status,
    });
  }
  return Array.from(map.values());
}

export function mergeDevices(
  entities: SpatialEntity[],
  worldState: CurrentWorldState | null,
): DynPoint[] {
  const map = new Map<string, DynPoint>();
  if (worldState) {
    for (const d of worldState.devices) {
      map.set(d.entityId, {
        entityId: d.entityId,
        name: d.name,
        x: d.x,
        y: d.y,
        status: d.status,
        deviceId: d.deviceId,
        workerId: d.workerId,
      });
    }
  }
  for (const e of entities) {
    if (e.entityType !== 'device') continue;
    if (map.has(e.entityId)) continue;
    map.set(e.entityId, {
      entityId: e.entityId,
      name: e.name,
      x: e.x,
      y: e.y,
      status: e.status,
    });
  }
  return Array.from(map.values());
}

// 静态层渲染顺序（底层 → 上层）。corridor 通道排最前（车间底层之上、
// 其余实体之下）；2026-08-20 前「通道生成未生效/显示不完整」的渲染侧根因
// 之一：白名单不含 corridor——即使数据层有通道实体，本过滤也会丢弃。
export const STATIC_ORDER = ['corridor', 'route', 'zone', 'production_line', 'workshop', 'restricted_zone'];

export interface ViewBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

/**
 * 感知覆盖范围（摄像头视锥 + UWB 覆盖圈）——必须纳入 viewBox，否则会被
 * preserveAspectRatio="xMidYMid meet" 裁切或推到视口边缘（用户反馈"监控视场角
 * 加载不全/显示异常"的根因）。坐标来自实体 extra：摄像头 fov_deg/range/range_m/
 * yaw，UWB coverage_r；与 FactoryMap 渲染逻辑（cameraFovPoints / coverage_r）同源。
 */
export interface PerceptionExtent {
  /** 摄像头视锥三角顶点（已含 yaw 旋转与 range 长度，worldBounds 用）。 */
  fovPoints: Array<{ x: number; y: number }>;
  /** UWB 覆盖圈圆心 + 半径（圆最远点 = 圆心 ± r）。 */
  uwbCircles: Array<{ x: number; y: number; r: number }>;
}

const MIN_CANVAS_W = 600;
const MIN_CANVAS_H = 420;
const PAD_RATIO = 0.06; // 留白 = 画布尺度 6%
const PAD_MIN = 40;
const PAD_MAX = 160;

/** 收集实体静态 bbox 角点（含 hw/hh 半宽高）到包围盒累加器。 */
function extendByBbox(
  acc: { minX: number; minY: number; maxX: number; maxY: number },
  x: number,
  y: number,
  hw: number,
  hh: number,
): void {
  acc.minX = Math.min(acc.minX, x - hw);
  acc.minY = Math.min(acc.minY, y - hh);
  acc.maxX = Math.max(acc.maxX, x + hw);
  acc.maxY = Math.max(acc.maxY, y + hh);
}

/**
 * 依据实体空间范围 + 感知覆盖（FOV/UWB）自适应计算 viewBox。
 *
 * 设计目标（指挥地图布局重设计，2026-08-22）：
 *  1) 所有元素（含摄像头视锥、UWB 覆盖圈、玛丽角色/人员、工厂）完整落在视口内，
 *     避免被裁切或推到边缘；
 *  2) 自适应留白（按画布尺度 6%，clamp 40~160）替代固定 24，缓解拥挤、提升层级；
 *  3) 保证最小画布尺寸（600×420），避免小场景被无限放大导致元素粘连；
 *  4) 维持纯函数、零 React 依赖。
 *
 * perception 缺省（null）时退化为仅实体 bbox（旧行为，保持兼容）。
 */
export function computeViewBox(
  entities: SpatialEntity[],
  perception?: PerceptionExtent | null,
): ViewBox {
  const fallback: ViewBox = { minX: 0, minY: 0, w: 1000, h: 700 };
  if (!entities.length) return fallback;

  const acc = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const e of entities) {
    const hw = (e.bboxW ?? 0) / 2;
    const hh = (e.bboxH ?? 0) / 2;
    extendByBbox(acc, e.x, e.y, hw, hh);
  }

  if (perception) {
    for (const p of perception.fovPoints) {
      extendByBbox(acc, p.x, p.y, 0, 0);
    }
    for (const c of perception.uwbCircles) {
      extendByBbox(acc, c.x, c.y, c.r, c.r);
    }
  }

  if (!Number.isFinite(acc.minX) || !Number.isFinite(acc.minY)) return fallback;

  const rawW = acc.maxX - acc.minX;
  const rawH = acc.maxY - acc.minY;
  // 自适应留白：随画布尺度增长，clamp 到 [PAD_MIN, PAD_MAX]。
  const pad = Math.min(PAD_MAX, Math.max(PAD_MIN, Math.max(rawW, rawH) * PAD_RATIO));
  // 保证最小画布：先按内容 + 留白定尺寸，再与最小画布取较大值（居中处理在下方）。
  const contentW = rawW + pad * 2;
  const contentH = rawH + pad * 2;
  const w = Math.max(contentW, MIN_CANVAS_W);
  const h = Math.max(contentH, MIN_CANVAS_H);

  // 当最小画布生效时，需要在内容四周均匀补白（而非单侧留白），保证内容居中、不被推边。
  const extraW = Math.max(0, w - contentW);
  const extraH = Math.max(0, h - contentH);

  return {
    minX: acc.minX - pad - extraW / 2,
    minY: acc.minY - pad - extraH / 2,
    w,
    h,
  };
}
