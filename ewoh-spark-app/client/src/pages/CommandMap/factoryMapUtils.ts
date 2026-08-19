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

/** 依据实体空间范围自适应计算 viewBox，避免实体挤在画布左上角。 */
export function computeViewBox(entities: SpatialEntity[]): ViewBox {
  const fallback: ViewBox = { minX: 0, minY: 0, w: 1000, h: 700 };
  if (!entities.length) return fallback;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entities) {
    const hw = (e.bboxW ?? 0) / 2;
    const hh = (e.bboxH ?? 0) / 2;
    minX = Math.min(minX, e.x - hw);
    minY = Math.min(minY, e.y - hh);
    maxX = Math.max(maxX, e.x + hw);
    maxY = Math.max(maxY, e.y + hh);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return fallback;
  const pad = 24;
  return {
    minX: minX - pad,
    minY: minY - pad,
    w: Math.max(maxX - minX + pad * 2, 120),
    h: Math.max(maxY - minY + pad * 2, 80),
  };
}
