/* spatialPointIndex.ts — 叠加层坐标源统一（审计报告 A1/A2，2026-08-19）。
 *
 * 问题：调度叠加层（SchedulerLayers / PlanCompareLayer / 执行偏差层）的坐标
 * 解析自 snapshot / ewoh_route_node / ewoh_device 等多个来源，而底图 viewBox
 * 来自空间实体（ewoh_spatial_entity，经 /api/spatial/entities）。任一来源布局
 * 漂移（route_node 旧坐标、device 表 location 与笛卡尔混载）都会让叠加标记
 * 相对底图整体错位——"图层开了没变化/标记画偏"。
 *
 * 修复原则：以空间实体为地图坐标唯一真源。按 entityId 建坐标索引（兼容
 * ADR-008 规范前缀 person:/device:/station:<id> 与裸 id 双向查找），叠加层
 * 坐标一律 spatial 优先、原值回退：数值一致时为 no-op，无空间实体时保持
 * 原坐标（不丢弃数据、不伪造坐标）。纯函数，node 可测。
 */
import type { RouteGraph, SpatialEntity } from '@shared/api.interface';
import type { PlanCompareMapVM } from './vm/planCompareVM';

export interface SpatialPoint {
  x: number;
  y: number;
}

/** id → 空间实体坐标（null = 无匹配，调用方回退原坐标）。 */
export type SpatialPointOf = (id: string) => SpatialPoint | null;

/** 空间实体 → 坐标索引（entityId / 裸 id / 规范前缀变体 → 同一坐标）。 */
export function buildSpatialPointIndex(entities: SpatialEntity[]): SpatialPointOf {
  const byKey = new Map<string, SpatialPoint>();
  for (const e of entities) {
    if (e.x == null || e.y == null) continue;
    const p: SpatialPoint = { x: e.x, y: e.y };
    byKey.set(e.entityId, p);
    const colon = e.entityId.indexOf(':');
    const bare = colon > 0 ? e.entityId.slice(colon + 1) : e.entityId;
    if (!byKey.has(bare)) byKey.set(bare, p);
    // 规范前缀变体（person:/device:/station:<bare>）→ 同一坐标。
    const prefix =
      e.entityType === 'person' || e.entityType === 'device'
        ? e.entityType
        : e.entityType === 'workstation' || e.entityType === 'station'
          ? 'station'
          : null;
    if (prefix) {
      const k = `${prefix}:${bare}`;
      if (!byKey.has(k)) byKey.set(k, p);
    }
  }
  return (id: string) => (id ? (byKey.get(id) ?? null) : null);
}

interface SnapshotLike {
  persons: Array<{ id: string; entityId?: string; x: number | null; y: number | null }>;
  devices: Array<{ id: string; entityId?: string; x?: number | null; y?: number | null }>;
  stations: Array<{ id: string; entityId?: string; x: number | null; y: number | null }>;
}

/**
 * 快照坐标对齐空间实体（persons/devices/stations 的 x/y 一律 spatial 优先）。
 * 无任何替换命中时返回原引用（保持 memo 稳定）。
 */
export function alignSnapshotToSpatial<T extends SnapshotLike>(snapshot: T, pointOf: SpatialPointOf): T {
  let personsChanged = false;
  const persons = snapshot.persons.map((p) => {
    const sp = pointOf(p.entityId ?? '') ?? pointOf(p.id);
    if (!sp || (sp.x === p.x && sp.y === p.y)) return p;
    personsChanged = true;
    return { ...p, x: sp.x, y: sp.y };
  });
  let devicesChanged = false;
  const devices = snapshot.devices.map((d) => {
    const sp = pointOf(d.entityId ?? '') ?? pointOf(d.id);
    if (!sp || (sp.x === d.x && sp.y === d.y)) return d;
    devicesChanged = true;
    return { ...d, x: sp.x, y: sp.y };
  });
  let stationsChanged = false;
  const stations = snapshot.stations.map((s) => {
    const sp = pointOf(s.entityId ?? '') ?? pointOf(s.id);
    if (!sp || (sp.x === s.x && sp.y === s.y)) return s;
    stationsChanged = true;
    return { ...s, x: sp.x, y: sp.y };
  });
  if (!personsChanged && !devicesChanged && !stationsChanged) return snapshot;
  return { ...snapshot, persons, devices, stations };
}

/**
 * 路由图节点坐标对齐空间实体：node.stationId 可解析出空间实体时，用空间实体
 * 坐标替换 node.x/y（route_node 表坐标与空间布局漂移时路线网仍贴合底图）。
 * 无命中返回原引用。
 */
export function alignRouteGraphToSpatial(graph: RouteGraph, pointOf: SpatialPointOf): RouteGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (!n.stationId) return n;
    const sp = pointOf(n.stationId);
    if (!sp || (sp.x === n.x && sp.y === n.y)) return n;
    changed = true;
    return { ...n, x: sp.x, y: sp.y };
  });
  if (!changed) return graph;
  return { ...graph, nodes };
}

/**
 * Plan Compare VM 坐标对齐空间实体：entry.before/after 按 stationId ?? personId
 * 重新解析（与 planCompareVM.snapshotPoint 同语义），解析成功则覆盖原点。
 * 返回浅拷贝（原 VM 不被修改）；vm 为 null 时返回 null。
 */
export function remapPlanCompareVmToSpatial(
  vm: PlanCompareMapVM | null,
  pointOf: SpatialPointOf,
): PlanCompareMapVM | null {
  if (!vm) return null;
  let changed = false;
  const entries = vm.entries.map((entry) => {
    const remapSide = (side: typeof entry.before): typeof entry.before => {
      if (!side) return side;
      const sp = pointOf(side.stationId ?? '') ?? pointOf(side.personId ?? '');
      if (!sp || (side.point && sp.x === side.point.x && sp.y === side.point.y)) return side;
      changed = true;
      return { ...side, point: { x: sp.x, y: sp.y } };
    };
    const before = remapSide(entry.before);
    const after = remapSide(entry.after);
    if (before === entry.before && after === entry.after) return entry;
    return { ...entry, before, after };
  });
  if (!changed) return vm;
  return { ...vm, entries };
}
