import { useMemo, useEffect, useRef } from 'react';
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from 'react-zoom-pan-pinch';
import { ZoomIn, ZoomOut, Maximize, Crosshair } from 'lucide-react';
import type {
  EnvironmentReading,
  SpatialEntity,
  CurrentWorldState,
  SchedulingPlanV2,
  RouteGraph,
  TaskCandidatesResponse,
} from '@shared/api.interface';
import { fitLabel, truncateLabel } from './labels';
import { UI_ARIA_LABELS } from '../../lib/a11y';

interface FactoryMapProps {
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  environmentReadings?: EnvironmentReading[];
  mode: string;
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  replayMode: boolean;
  replayTime: string | null;
  /** 调度模式：高亮某方案受影响人员（来自调度面板「在图上查看」） */
  focusPlanPersons?: string[];
  onFocusPlanPersonsConsumed?: () => void;
  /** 调度方案路由叠加层：shadow 方案虚线、已审批/已下发实线、预测人员位置、目标工位、拥堵/阻断边 */
  planOverlay?: { plan: SchedulingPlanV2 | null; routeGraph?: RouteGraph | null };
  /** 智能调度驾驶舱：选中任务的候选资源（后端返回，只读展示）。 */
  candidates?: TaskCandidatesResponse | null;
  /** 智能调度驾驶舱：当前选中的任务（用于在图上高亮其候选人员）。 */
  selectedTaskId?: string | null;
}

/** 摄像头视锥三角形顶点（yaw=0 朝右，按 yaw 旋转） */
function cameraFovPoints(x: number, y: number, yaw: number, fovDeg: number, range: number): string {
  const yawRad = (yaw * Math.PI) / 180;
  const halfFov = (fovDeg * Math.PI) / 360;
  const p1x = x + range * Math.cos(yawRad - halfFov);
  const p1y = y + range * Math.sin(yawRad - halfFov);
  const p2x = x + range * Math.cos(yawRad + halfFov);
  const p2y = y + range * Math.sin(yawRad + halfFov);
  return `${x},${y} ${p1x},${p1y} ${p2x},${p2y}`;
}

/** 设备是否为外骨骼装备（按实体名/ID 含 EXO 判断） */
function isExoDevice(entity: SpatialEntity): boolean {
  return /EXO|外骨骼/i.test(`${entity.name} ${entity.entityId}`);
}

/** 按 mode 计算实体填充颜色 */
function getEntityColor(
  entity: SpatialEntity,
  mode: string,
  worldState: CurrentWorldState | null,
): string {
  switch (mode) {
    case 'production':
      if (entity.entityType === 'workstation') {
        // 优先用实时工位占用率着色（与 L2 WIP/节拍逻辑一致），无实时数据时回退静态状态
        const occ = worldState?.workstations?.find(
          (w) => w.entityId === entity.entityId,
        )?.occupancy;
        if (occ == null) {
          if (entity.status === 'producing') return '#10b981';
          if (entity.status === 'warning') return '#f59e0b';
          return '#6b7280';
        }
        if (occ < 0.4) return '#10b981';
        if (occ < 0.7) return '#f59e0b';
        return '#ef4444';
      }
      return '#3b82f6';
    case 'person':
      return entity.entityType === 'person' ? '#06b6d4' : '#4b5563';
    case 'exoskeleton':
      // 仅外骨骼装备按其在线态着色，其余设备统一灰色
      if (entity.entityType === 'device' && isExoDevice(entity)) {
        const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
        return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
      }
      return '#4b5563';
    case 'body_load':
      if (entity.entityType === 'person') {
        const p = worldState?.persons.find((pp) => pp.entityId === entity.entityId);
        const score = p?.loadScore;
        if (score == null) return '#6b7280';
        if (score < 0.3) return '#10b981';
        if (score < 0.6) return '#f59e0b';
        if (score < 0.8) return '#f97316';
        return '#ef4444';
      }
      return '#4b5563';
    case 'safety_risk':
      return entity.entityType === 'restricted_zone' ? '#ef4444' : '#4b5563';
    case 'device':
      if (entity.entityType === 'device') {
        const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
        return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
      }
      return '#4b5563';
    case 'environment':
      // 无真实环境数据时用中性色，避免误导
      if (entity.entityType === 'zone') {
        return 'rgba(34,211,238,0.25)';
      }
      return '#4b5563';
    case 'scheduling':
      return entity.entityType === 'person' ? '#a855f7' : '#4b5563';
    case 'data_quality':
      if (entity.confidence > 0.95) return '#10b981';
      if (entity.confidence >= 0.8) return '#f59e0b';
      return '#ef4444';
    default:
      return '#3b82f6';
  }
}

/** 设备层着色：依赖 mode 决定是否区分外骨骼 */
function getDeviceColor(
  entity: SpatialEntity,
  mode: string,
  worldState: CurrentWorldState | null,
): string {
  if (mode === 'exoskeleton') {
    // 外骨骼装备按在线态着色，其余设备统一灰色
    if (!isExoDevice(entity)) return '#4b5563';
    const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
    return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
  }
  if (mode === 'device' || mode === 'production') {
    const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
    return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
  }
  return '#4b5563';
}

interface StaticStyle {
  fill: string;
  stroke: string;
  dash?: string;
}

/** 后端 priority.level 的触点颜色（智能调度驾驶舱徽标用，展示层映射）。 */
function priorityLevelColor(level?: string): string {
  switch (level) {
    case 'urgent':
    case 'critical':
      return '#ef4444';
    case 'high':
      return '#f97316';
    case 'medium':
    case 'normal':
      return '#f59e0b';
    case 'low':
      return '#3b82f6';
    default:
      return '#a855f7';
  }
}

/** 资源可用性层：将后端 status 值映射为展示色（available/busy/unavailable/offline/fault/stale 等）。 */
function resourceStatusColor(status?: string): string {
  switch (status) {
    case 'offline':
    case 'unavailable':
    case 'fault':
    case 'faulted':
      return '#ef4444';
    case 'busy':
    case 'occupied':
    case 'executing':
      return '#f97316';
    case 'reserved':
      return '#f59e0b';
    case 'stale':
      return '#6b7280';
    case 'idle':
    case 'available':
    case 'online':
    case 'ready':
    default:
      return '#34d399';
  }
}

function getStaticStyle(type: string): StaticStyle {
  switch (type) {
    case 'workshop':
      return { fill: 'rgba(59,130,246,0.15)', stroke: 'rgba(59,130,246,0.5)' };
    case 'production_line':
      return { fill: 'rgba(168,85,247,0.10)', stroke: 'rgba(168,85,247,0.4)' };
    case 'route':
      return { fill: 'rgba(148,163,184,0.06)', stroke: 'rgba(148,163,184,0.3)' };
    case 'restricted_zone':
      return { fill: 'rgba(239,68,68,0.12)', stroke: 'rgba(239,68,68,0.6)', dash: '4 4' };
    case 'zone':
    default:
      return { fill: 'rgba(59,130,246,0.08)', stroke: 'rgba(59,130,246,0.4)' };
  }
}

/** 合并 worldState 与静态 entities 的人员/设备位置 */
interface DynPoint {
  entityId: string;
  name: string;
  x: number;
  y: number;
  status: string;
  loadScore?: number;
  deviceId?: string;
  workerId?: string;
}

function mergePersons(
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

function mergeDevices(
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

const STATIC_ORDER = ['route', 'zone', 'production_line', 'workshop', 'restricted_zone'];

interface ViewBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

type ZoomToElement = ReactZoomPanPinchRef['zoomToElement'];

/** 依据实体空间范围自适应计算 viewBox，避免实体挤在画布左上角。 */
function computeViewBox(entities: SpatialEntity[]): ViewBox {
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

const FactoryMap = ({
  entities,
  worldState,
  environmentReadings = [],
  mode,
  level,
  selectedEntityId,
  onSelectEntity,
  replayMode,
  replayTime,
  focusPlanPersons = [],
  onFocusPlanPersonsConsumed,
  planOverlay,
  candidates = null,
  selectedTaskId = null,
}: FactoryMapProps): React.ReactElement => {
  const staticEntities = useMemo(
    () =>
      entities
        .filter((e) => STATIC_ORDER.includes(e.entityType))
        .sort(
          (a, b) =>
            STATIC_ORDER.indexOf(a.entityType) - STATIC_ORDER.indexOf(b.entityType),
        ),
    [entities],
  );

  const workstations = useMemo(
    () => entities.filter((e) => e.entityType === 'workstation'),
    [entities],
  );
  const cameras = useMemo(
    () => entities.filter((e) => e.entityType === 'camera'),
    [entities],
  );
  const uwbStations = useMemo(
    () => entities.filter((e) => e.entityType === 'uwb_station'),
    [entities],
  );

  const persons = useMemo(() => mergePersons(entities, worldState), [entities, worldState]);
  const devices = useMemo(() => mergeDevices(entities, worldState), [entities, worldState]);

  // 智能调度驾驶舱：任务优先级徽标（后端 decisionTrace.priority，展示用，不本地复算）。
  const priorityMarkers = useMemo(() => {
    const plan = planOverlay?.plan;
    if (!plan) return [];
    const stationOf = (id: string | null) => {
      if (!id) return null;
      const w = workstations.find((x) => x.entityId === id);
      if (w) return { x: w.x, y: w.y };
      const s = entities.find((x) => x.entityId === id);
      return s ? { x: s.x, y: s.y } : null;
    };
    return plan.assignments
      .map((a) => {
        const p = a.decisionTrace?.priority;
        if (!p) return null;
        const point = stationOf(a.stationId);
        return point ? { assignment: a, priority: p, point } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [planOverlay, workstations, entities]);

  // 智能调度驾驶舱：将候选的人员 entityId/姓名 匹配到地图人员坐标（尽力匹配，无则不渲染圆环）。
  const candidateFocus = useMemo(() => {
    if (!selectedTaskId || !candidates) return null;
    const byId = new Map(persons.map((p) => [p.entityId, p]));
    const byName = new Map(persons.map((p) => [p.name, p]));
    return candidates.candidates.map((c) => ({
      candidate: c,
      point: byId.get(c.personId) ?? byName.get(c.personName) ?? null,
    }));
  }, [selectedTaskId, candidates, persons]);

  // 生产模式：工位间流动连线（按 x 坐标排序模拟产线流向）
  const flowLines = useMemo(() => {
    if (mode !== 'production') return [];
    const sorted = [...workstations].sort((a, b) => a.x - b.x);
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; takt: string }> = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      // 用 occupancy 作为节拍代理：占用率高=节拍慢
      const aState = worldState?.workstations?.find((w) => w.entityId === a.entityId);
      const occupancy = aState?.occupancy ?? 0.5;
      const taktColor = occupancy < 0.4 ? '#10b981' : occupancy < 0.7 ? '#f59e0b' : '#ef4444';
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, takt: taktColor });
    }
    return lines;
  }, [workstations, mode, worldState]);

  const hasEnvironmentData = environmentReadings.length > 0;

  const isSelected = (id: string) => selectedEntityId === id;
  const strokeFor = (id: string, base: string) => (isSelected(id) ? '#fbbf24' : base);
  const strokeWidthFor = (id: string, base: number) => (isSelected(id) ? 3 : base);

  // 自适应 viewBox：依据实体实际空间范围
  const viewBox = useMemo(() => computeViewBox(entities), [entities]);

  // 层级 = 同一张地图上的信息密度：
  //   L0 基础结构（仅静态元素，无动态人员/设备）
  //   L1 +感知覆盖(摄像头/UWB) + 动态人员/设备
  //   L2 +生产节拍/安全风险等全量态势
  //   L3 工位近景 | L4 人员跟随（近景模式，自动缩放定位到焦点实体）
  const showDynamic = level !== 'L0';
  const showPerception = level === 'L1' || level === 'L2';
  const showDensity = level === 'L2';
  const isNearView = level === 'L3' || level === 'L4';

  const focus = useMemo(() => {
    if (!isNearView) return null;
    // 近景必须选中目标实体，避免未选中时随机聚焦造成迷失
    if (!selectedEntityId) return null;
    return entities.find((e) => e.entityId === selectedEntityId) ?? null;
  }, [isNearView, selectedEntityId, entities]);

  // 近景目标点：优先取动态位置，回落到静态坐标
  const targetPos = useMemo(() => {
    if (!focus) return null;
    if (focus.entityType === 'person') {
      const dp = persons.find((p) => p.entityId === focus.entityId);
      if (dp) return { x: dp.x, y: dp.y };
    }
    if (focus.entityType === 'device') {
      const dd = devices.find((d) => d.entityId === focus.entityId);
      if (dd) return { x: dd.x, y: dd.y };
    }
    return { x: focus.x, y: focus.y };
  }, [focus, persons, devices]);

  const nearScale = level === 'L4' ? 3 : 2.5;

  const zoomToElementRef = useRef<ZoomToElement | null>(null);
  const resetTransformRef = useRef<(() => void) | null>(null);

  // 进入近景或焦点变化时，自动缩放到目标实体
  useEffect(() => {
    if (!isNearView || !focus) return;
    const fn = zoomToElementRef.current;
    if (!fn) return;
    const t = window.setTimeout(() => {
      fn('nearview-target', nearScale, 300, 'easeOut');
    }, 80);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNearView, focus?.entityId, nearScale]);

  // L4 人员跟随：选中人员后，其位置变化时持续居中
  const followTarget = level === 'L4' && selectedEntityId && focus?.entityType === 'person' ? targetPos : null;
  useEffect(() => {
    if (!isNearView || !followTarget) return;
    const fn = zoomToElementRef.current;
    if (!fn) return;
    fn('nearview-target', nearScale, 250, 'easeOut');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNearView, followTarget?.x, followTarget?.y, nearScale]);

  // 退出近景时回到整体视图
  useEffect(() => {
    if (!isNearView) {
      resetTransformRef.current?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNearView]);

  return (
    <div className="relative flex-1 min-w-0 bg-[hsl(220_14%_8%)] overflow-hidden">
      <TransformWrapper
        initialScale={1}
        minScale={0.3}
        maxScale={8}
        centerOnInit
        smooth
        wheel={{ step: 0.0012 }}
        doubleClick={{ mode: 'zoomIn', step: 0.7 }}
        zoomAnimation={{ disabled: false, size: 0.4, animationTime: 200, animationType: 'easeOut' }}
      >
        {({ zoomIn, zoomOut, resetTransform, zoomToElement }) => {
          zoomToElementRef.current = zoomToElement;
          resetTransformRef.current = resetTransform;
          return (
            <>
              <TransformComponent
                wrapperClass="!w-full !h-full !cursor-grab active:!cursor-grabbing"
                contentClass="!w-full !h-full"
              >
      <svg
        viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full"
      >
        {/* 背景点击区域：点击空白处取消选中 */}
        <rect
          x={viewBox.minX}
          y={viewBox.minY}
          width={viewBox.w}
          height={viewBox.h}
          fill="transparent"
          onClick={() => onSelectEntity(null)}
        />

        {/* 网格背景 */}
        <defs>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x={viewBox.minX} y={viewBox.minY} width={viewBox.w} height={viewBox.h} fill="url(#grid)" pointerEvents="none" />

        {/* 1. 静态底图层 */}
        {staticEntities.map((e) => {
          const style = getStaticStyle(e.entityType);
          const x = e.x - e.bboxW / 2;
          const y = e.y - e.bboxH / 2;
          let fill = style.fill;
          const label = fitLabel(e.name, e.bboxW, 11);
          return (
            <g
              key={e.entityId}
              onClick={() => onSelectEntity(e.entityId)}
              style={{ cursor: 'pointer' }}
            >
              <title>{e.name}</title>
              <rect
                x={x}
                y={y}
                width={e.bboxW}
                height={e.bboxH}
                fill={fill}
                stroke={strokeFor(e.entityId, style.stroke)}
                strokeWidth={strokeWidthFor(e.entityId, 1.5)}
                strokeDasharray={style.dash}
                rx="4"
              />
              {label && (
                <text
                  x={e.x}
                  y={e.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="rgba(255,255,255,0.65)"
                  fontSize="11"
                  pointerEvents="none"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* 2. 感知覆盖层（L1/L2）：摄像头视锥 + UWB 覆盖圈 */}
        {showPerception && (
          <>
            {cameras.map((c) => {
              const extra = c.extra as { fov_deg?: number; range?: number } | null;
              const fov = extra?.fov_deg ?? 90;
              const range = extra?.range ?? 200;
              return (
                <polygon
                  key={`fov-${c.entityId}`}
                  points={cameraFovPoints(c.x, c.y, c.yaw, fov, range)}
                  fill="rgba(59,130,246,0.12)"
                  stroke="rgba(59,130,246,0.25)"
                  strokeWidth="1"
                  pointerEvents="none"
                />
              );
            })}
            {uwbStations.map((u) => {
              const extra = u.extra as { coverage_r?: number } | null;
              const r = extra?.coverage_r ?? 150;
              return (
                <g key={`uwb-${u.entityId}`}>
                  <circle
                    cx={u.x}
                    cy={u.y}
                    r={r}
                    fill="rgba(34,211,238,0.06)"
                    stroke="rgba(34,211,238,0.3)"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                  <circle
                    cx={u.x}
                    cy={u.y}
                    r={5}
                    fill="rgba(34,211,238,0.9)"
                    onClick={() => onSelectEntity(u.entityId)}
                    style={{ cursor: 'pointer' }}
                  />
                  <text
                    x={u.x}
                    y={u.y - 10}
                    textAnchor="middle"
                    fill="rgba(34,211,238,0.9)"
                    fontSize="9"
                    pointerEvents="none"
                  >
                    {truncateLabel(u.name, 10)}
                  </text>
                </g>
              );
            })}
            {cameras.map((c) => (
              <g key={`cam-${c.entityId}`}>
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={5}
                  fill="rgba(59,130,246,0.9)"
                  stroke={strokeFor(c.entityId, '#fff')}
                  strokeWidth={isSelected(c.entityId) ? 3 : 1}
                  onClick={() => onSelectEntity(c.entityId)}
                  style={{ cursor: 'pointer' }}
                />
                <text
                  x={c.x}
                  y={c.y - 10}
                  textAnchor="middle"
                  fill="rgba(59,130,246,0.9)"
                  fontSize="9"
                  pointerEvents="none"
                >
                  {truncateLabel(c.name, 10)}
                </text>
              </g>
            ))}
          </>
        )}

        {/* 3. 调度模式：优先展示「在图上查看」方案的受影响人员连线；否则回退到选中人员的关联连线 */}
        {showDynamic &&
          mode === 'scheduling' &&
          (focusPlanPersons.length > 1
            ? (() => {
                const focused = focusPlanPersons
                  .map((id) => persons.find((p) => p.entityId === id))
                  .filter((p): p is DynPoint => Boolean(p));
                if (focused.length < 2) return null;
                return (
                  <g pointerEvents="none">
                    <polyline
                      points={focused.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke="rgba(168,85,247,0.6)"
                      strokeWidth="2.5"
                      strokeDasharray="6 4"
                    />
                    {focused.slice(1).map((p) => (
                      <line
                        key={`flink-${focused[0].entityId}-${p.entityId}`}
                        x1={focused[0].x}
                        y1={focused[0].y}
                        x2={p.x}
                        y2={p.y}
                        stroke="rgba(168,85,247,0.3)"
                        strokeWidth="1"
                      />
                    ))}
                  </g>
                );
              })()
            : persons.length > 1 && selectedEntityId
              ? (() => {
                  const sel = persons.find((p) => p.entityId === selectedEntityId);
                  if (!sel) return null;
                  const connected = [
                    sel,
                    ...persons.filter((p) => p.entityId !== selectedEntityId),
                  ];
                  return (
                    <g pointerEvents="none">
                      <polyline
                        points={connected.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke="rgba(168,85,247,0.5)"
                        strokeWidth="2"
                        strokeDasharray="6 4"
                      />
                      {connected.slice(1).map((p) => (
                        <line
                          key={`link-${sel.entityId}-${p.entityId}`}
                          x1={sel.x}
                          y1={sel.y}
                          x2={p.x}
                          y2={p.y}
                          stroke="rgba(168,85,247,0.25)"
                          strokeWidth="1"
                        />
                      ))}
                    </g>
                  );
                })()
              : null)}

        {/* 3.6 调度方案覆盖层：路由图 + 分配路由（人员→目标工位）+ 预测人员 + 拥堵/阻断边 */}
        {showDynamic &&
          mode === 'scheduling' &&
          planOverlay?.plan &&
          (() => {
            const plan = planOverlay.plan;
            const graph = planOverlay.routeGraph;
            const nodeMap = new Map((graph?.nodes ?? []).map((n) => [n.nodeId, n]));
            const personCoord = (id: string | null) => {
              if (!id) return null;
              const p = persons.find((x) => x.entityId === id);
              if (p) return { x: p.x, y: p.y };
              const e = entities.find((x) => x.entityId === id);
              return e ? { x: e.x, y: e.y } : null;
            };
            const stationCoord = (id: string | null) => {
              if (!id) return null;
              const w = workstations.find((x) => x.entityId === id);
              if (w) return { x: w.x, y: w.y };
              const s = entities.find((x) => x.entityId === id);
              return s ? { x: s.x, y: s.y } : null;
            };
            const approved =
              plan.status === 'approved' ||
              plan.status === 'dispatched' ||
              plan.status === 'executing';
            const routeColor = approved ? '#34d399' : '#a855f7';
            const dash = approved ? undefined : '6 4';
            const edgeGeoms = (graph?.edges ?? [])
              .map((e) => {
                const f = nodeMap.get(e.fromNodeId);
                const t = nodeMap.get(e.toNodeId);
                if (!f || !t) return null;
                return { e, f, t };
              })
              .filter((x): x is NonNullable<typeof x> => Boolean(x));
            return (
              <g pointerEvents="none">
                {/* 路由图边（拥堵/阻断高亮） */}
                {edgeGeoms.map(({ e, f, t }) => {
                  const blocked = e.status === 'blocked';
                  const congested = e.status === 'congested';
                  const color = blocked
                    ? '#ef4444'
                    : congested
                      ? '#f59e0b'
                      : 'rgba(148,163,184,0.35)';
                  const mx = (f.x + t.x) / 2;
                  const my = (f.y + t.y) / 2;
                  return (
                    <g key={e.edgeId}>
                      <line
                        x1={f.x}
                        y1={f.y}
                        x2={t.x}
                        y2={t.y}
                        stroke={color}
                        strokeWidth={blocked || congested ? 2.5 : 1}
                        strokeDasharray={congested ? '4 3' : undefined}
                        opacity={blocked || congested ? 0.9 : 0.6}
                      >
                        {congested && (
                          <animate
                            attributeName="stroke-dashoffset"
                            values="0;-7"
                            dur="0.6s"
                            repeatCount="indefinite"
                          />
                        )}
                      </line>
                      {blocked && (
                        <g>
                          <circle cx={mx} cy={my} r={5} fill="#ef4444" opacity="0.9" />
                          <text x={mx} y={my - 7} textAnchor="middle" fill="#ef4444" fontSize="9">
                            阻断
                          </text>
                        </g>
                      )}
                      {congested && (
                        <g>
                          <circle cx={mx} cy={my} r={4} fill="#f59e0b" opacity="0.9" />
                          <text x={mx} y={my - 7} textAnchor="middle" fill="#f59e0b" fontSize="9">
                            拥堵
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {/* 分配路由：人员 → 目标工位；shadow=虚线，approved/dispatched=实线 */}
                {plan.assignments.map((a) => {
                  const from = personCoord(a.personId);
                  const to = stationCoord(a.stationId);
                  if (!from || !to) return null;
                  return (
                    <line
                      key={`aro-${a.assignmentId}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={routeColor}
                      strokeWidth={2}
                      strokeDasharray={dash}
                      opacity={0.85}
                    />
                  );
                })}
                {/* 目标工位标记 + 预测人员位置 */}
                {plan.assignments.map((a) => {
                  const to = stationCoord(a.stationId);
                  if (!to) return null;
                  return (
                    <g key={`amk-${a.assignmentId}`}>
                      <rect
                        x={to.x - 8}
                        y={to.y - 8}
                        width={16}
                        height={16}
                        fill="none"
                        stroke={routeColor}
                        strokeWidth={1.5}
                        rx="2"
                        strokeDasharray={dash}
                      />
                      {a.personId && (
                        <circle
                          cx={to.x}
                          cy={to.y}
                          r={6}
                          fill={routeColor}
                          opacity={0.35}
                          stroke={routeColor}
                          strokeWidth={1}
                          strokeDasharray={dash}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })()}

        {/* 3.7 智能调度驾驶舱：任务优先级徽标 + 候选人员高亮（纯后端数据，只读展示） */}
        {mode === 'scheduling' && planOverlay?.plan && priorityMarkers.length > 0 && (
          <g pointerEvents="none">
            {priorityMarkers.map(({ assignment, priority, point }) => (
              <g key={`iprio-${assignment.assignmentId}`}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={11}
                  fill="none"
                  stroke={priorityLevelColor(priority.level)}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  opacity={0.85}
                />
                <text
                  x={point.x}
                  y={point.y - 15}
                  textAnchor="middle"
                  fill={priorityLevelColor(priority.level)}
                  fontSize="8"
                  fontWeight="bold"
                >
                  {priority.score.toFixed(1)}
                </text>
              </g>
            ))}
          </g>
        )}
        {candidateFocus && candidateFocus.length > 0 && (
          <g pointerEvents="none">
            {candidateFocus.map(({ candidate, point }) => {
              if (!point) return null;
              const color = candidate.eligible ? '#10b981' : '#ef4444';
              return (
                <circle
                  key={`icand-${candidate.personId}-${candidate.deviceId ?? 'none'}`}
                  cx={point.x}
                  cy={point.y}
                  r={12}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  opacity={candidate.eligible ? 0.9 : 0.5}
                >
                  {candidate.eligible && (
                    <animate
                      attributeName="r"
                      values="10;15;10"
                      dur="1.2s"
                      repeatCount="indefinite"
                    />
                  )}
                </circle>
              );
            })}
          </g>
        )}

        {/* 3.5 生产模式：工位间流动虚线 + WIP 气泡 + 节拍脉冲（L2 全量态势显示） */}
        {showDensity && mode === 'production' && flowLines.map((line, i) => (
          <g key={`flow-${i}`}>
            <line
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke={line.takt}
              strokeWidth="2"
              strokeDasharray="8 4"
              opacity="0.6"
              pointerEvents="none"
            >
              <animate
                attributeName="stroke-dashoffset"
                values="0;-12"
                dur="0.8s"
                repeatCount="indefinite"
              />
            </line>
          </g>
        ))}
        {showDensity &&
          mode === 'production' &&
          workstations.map((w) => {
            const wsState = worldState?.workstations?.find((ws) => ws.entityId === w.entityId);
            const occupancy = wsState?.occupancy ?? 0.5;
            const wip = Math.round(occupancy * 10);
            const taktColor = occupancy < 0.4 ? '#10b981' : occupancy < 0.7 ? '#f59e0b' : '#ef4444';
            return (
              <g key={`wip-${w.entityId}`} pointerEvents="none">
                {/* WIP 数量气泡 */}
                <circle
                  cx={w.x + w.bboxW / 2 + 4}
                  cy={w.y - w.bboxH / 2 - 4}
                  r={9}
                  fill={taktColor}
                  opacity="0.9"
                />
                <text
                  x={w.x + w.bboxW / 2 + 4}
                  y={w.y - w.bboxH / 2 - 4}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="white"
                  fontSize="9"
                  fontWeight="bold"
                >
                  {wip}
                </text>
                {/* 节拍脉冲环 */}
                <rect
                  x={w.x - w.bboxW / 2 - 2}
                  y={w.y - w.bboxH / 2 - 2}
                  width={w.bboxW + 4}
                  height={w.bboxH + 4}
                  fill="none"
                  stroke={taktColor}
                  strokeWidth="1"
                  opacity="0.4"
                  rx="3"
                >
                  <animate
                    attributeName="opacity"
                    values="0.4;0.1;0.4"
                    dur={`${Math.max(1, (1 - occupancy) * 4)}s`}
                    repeatCount="indefinite"
                  />
                </rect>
              </g>
            );
          })}

        {/* 4. 工位层 */}
        {workstations.map((w) => {
          const x = w.x - w.bboxW / 2;
          const y = w.y - w.bboxH / 2;
          const color = getEntityColor(w, mode, worldState);
          const label = fitLabel(w.name, Math.max(w.bboxW, 24), 9);
          return (
            <g
              key={w.entityId}
              onClick={() => onSelectEntity(w.entityId)}
              style={{ cursor: 'pointer' }}
            >
              <rect
                x={x}
                y={y}
                width={Math.max(w.bboxW, 24)}
                height={Math.max(w.bboxH, 18)}
                fill={color}
                fillOpacity={0.5}
                stroke={strokeFor(w.entityId, color)}
                strokeWidth={strokeWidthFor(w.entityId, 1.5)}
                rx="2"
              />
              {label && (
                <text
                  x={w.x}
                  y={w.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="rgba(255,255,255,0.9)"
                  fontSize="9"
                  pointerEvents="none"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* 5. 设备层（动态） */}
        {showDynamic && devices.map((d) => {
          const ent = entities.find((e) => e.entityId === d.entityId);
          const fill = ent ? getDeviceColor(ent, mode, worldState) : '#4b5563';
          return (
            <g
              key={`dev-${d.entityId}`}
              onClick={() => onSelectEntity(d.entityId)}
              style={{ cursor: 'pointer' }}
            >
              {/* 资源可用性层：调度模式下用后端 status 渲染状态环（展示用，不本地判定） */}
              {mode === 'scheduling' && (
                <>
                  <circle
                    cx={d.x}
                    cy={d.y}
                    r={9}
                    fill="none"
                    stroke={resourceStatusColor(d.status)}
                    strokeWidth={1.5}
                    opacity={0.9}
                    pointerEvents="none"
                  />
                  <text
                    x={d.x}
                    y={d.y + 15}
                    textAnchor="middle"
                    fill={resourceStatusColor(d.status)}
                    fontSize="8"
                    pointerEvents="none"
                  >
                    {d.status}
                  </text>
                </>
              )}
              <circle
                cx={d.x}
                cy={d.y}
                r={6}
                fill={fill}
                stroke={strokeFor(d.entityId, '#fff')}
                strokeWidth={isSelected(d.entityId) ? 3 : 1.5}
              />
              <text
                x={d.x}
                y={d.y - 10}
                textAnchor="middle"
                fill="rgba(255,255,255,0.75)"
                fontSize="9"
                pointerEvents="none"
              >
                {truncateLabel(d.name, 10)}
              </text>
            </g>
          );
        })}

        {/* 6. 人员层（动态） */}
        {showDynamic && persons.map((p) => {
          let fill = '#06b6d4';
          if (mode === 'body_load') {
            const s = p.loadScore;
            if (s == null) fill = '#6b7280';
            else if (s < 0.3) fill = '#10b981';
            else if (s < 0.6) fill = '#f59e0b';
            else if (s < 0.8) fill = '#f97316';
            else fill = '#ef4444';
          } else if (mode === 'scheduling') {
            fill = '#a855f7';
          } else if (mode === 'person') {
            fill = '#06b6d4';
          } else if (mode === 'data_quality') {
            const ent = entities.find((e) => e.entityId === p.entityId);
            const c = ent?.confidence ?? 0;
            if (c > 0.95) fill = '#10b981';
            else if (c >= 0.8) fill = '#f59e0b';
            else fill = '#ef4444';
          } else if (mode === 'exoskeleton') {
            // 佩戴外骨骼装备的人员高亮，其余人员灰显
            const bound = p.deviceId
              ? entities.find((e) => e.entityId === p.deviceId)
              : null;
            fill = bound && isExoDevice(bound) ? '#8b5cf6' : '#4b5563';
          }
          return (
            <g
              key={`per-${p.entityId}`}
              onClick={() => onSelectEntity(p.entityId)}
              style={{ cursor: 'pointer' }}
            >
              {/* 资源可用性层：调度模式下用后端 status 渲染状态环（展示用，不本地判定） */}
              {mode === 'scheduling' && (
                <>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={10}
                    fill="none"
                    stroke={resourceStatusColor(p.status)}
                    strokeWidth={1.5}
                    opacity={0.9}
                    pointerEvents="none"
                  />
                  <text
                    x={p.x}
                    y={p.y + 16}
                    textAnchor="middle"
                    fill={resourceStatusColor(p.status)}
                    fontSize="8"
                    pointerEvents="none"
                  >
                    {p.status}
                  </text>
                </>
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={7}
                fill={fill}
                stroke={strokeFor(p.entityId, '#ffffff')}
                strokeWidth={isSelected(p.entityId) ? 3 : 1.5}
              />
              <text
                x={p.x}
                y={p.y - 11}
                textAnchor="middle"
                fill="rgba(255,255,255,0.9)"
                fontSize="9"
                pointerEvents="none"
              >
                {truncateLabel(p.name, 10)}
              </text>
            </g>
          );
        })}

        {/* 近景模式：透明定位标记，用于 zoomToElement 聚焦 */}
        {isNearView && focus && targetPos && (
          <circle
            id="nearview-target"
            cx={targetPos.x}
            cy={targetPos.y}
            r={1}
            fill="transparent"
            pointerEvents="none"
          />
        )}

        {/* 选中实体高亮光环 */}
        {selectedEntityId &&
          (() => {
            const sel = entities.find((e) => e.entityId === selectedEntityId);
            if (!sel) return null;
            return (
              <circle
                cx={sel.x}
                cy={sel.y}
                r={14}
                fill="none"
                stroke="#fbbf24"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                pointerEvents="none"
              >
                <animate attributeName="r" values="12;18;12" dur="1.5s" repeatCount="indefinite" />
              </circle>
            );
          })()}
      </svg>
            </TransformComponent>

            {/* 右上角缩放控件 */}
            <div className="absolute top-3 right-3 flex flex-col gap-1 z-10">
              {isNearView && (
                <button
                  onClick={() => resetTransform()}
                  className="w-8 h-8 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
                  title="返回整体视图"
                  aria-label={UI_ARIA_LABELS.resetView}
                >
                  <Crosshair className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => zoomIn()}
                className="w-8 h-8 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="放大"
                aria-label={UI_ARIA_LABELS.zoomIn}
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => zoomOut()}
                className="w-8 h-8 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="缩小"
                aria-label={UI_ARIA_LABELS.zoomOut}
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                onClick={() => resetTransform()}
                className="w-8 h-8 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="重置"
                aria-label={UI_ARIA_LABELS.resetView}
              >
                <Maximize className="w-4 h-4" />
              </button>
            </div>
          </>
          );
        }}
      </TransformWrapper>

      {/* 回放模式提示条 */}
      {replayMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-[hsl(265_73%_45%)] text-white text-xs font-medium shadow-lg z-10">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          回放中:{' '}
          {replayTime
            ? new Date(replayTime).toLocaleString('zh-CN', { hour12: false })
            : '—'}
        </div>
      )}

      {/* 近景模式提示 */}
      {isNearView && focus && (
        <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[70%] items-center gap-2 rounded-lg border border-white/10 bg-[hsl(220_14%_14%)]/90 px-3 py-1.5 text-xs text-white/80 shadow-xl backdrop-blur">
          <Crosshair className="w-3.5 h-3.5 text-[hsl(262_83%_58%)]" />
          <span className="truncate">
            {level === 'L3' ? '工位近景' : '人员跟随'}：{focus.name}
          </span>
          <span className="text-white/50">滚轮缩放 · 重置回整体</span>
        </div>
      )}
      {isNearView && !focus && (
        <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[70%] items-center gap-2 rounded-lg border border-white/10 bg-[hsl(220_14%_14%)]/90 px-3 py-1.5 text-xs text-white/80 shadow-xl backdrop-blur">
          <Crosshair className="w-3.5 h-3.5 text-white/40" />
          <span className="truncate text-white/60">
            请先在地图上选择{level === 'L3' ? '一个工位' : '一名人员'}以进入近景
          </span>
        </div>
      )}

      {/* 空数据占位 */}
      {entities.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm pointer-events-none">
          暂无空间实体数据
        </div>
      )}

      {/* 环境模式：无真实环境数据时明确空态 */}
      {mode === 'environment' && !hasEnvironmentData && (
        <div className="pointer-events-none absolute inset-x-0 top-12 z-10 flex justify-center px-4">
          <div className="rounded-lg border border-white/10 bg-[hsl(220_14%_14%)]/90 px-4 py-2 text-xs text-white/70 shadow-xl backdrop-blur">
            环境模式暂无实时环境数据，等待传感器接入后展示温湿度态势。
          </div>
        </div>
      )}

      {/* 底部状态条 */}
      <div className="absolute bottom-2 left-3 flex items-center gap-3 text-[10px] text-white/60 pointer-events-none z-10">
        <span>模式: {mode}</span>
        <span>·</span>
        <span>层级: {level}</span>
        <span>·</span>
        <span>实体: {entities.length}</span>
        {mode === 'environment' && (
          <>
            <span>·</span>
            <span>环境数据: {hasEnvironmentData ? environmentReadings.length : '无'}</span>
          </>
        )}
        {worldState && (
          <>
            <span>·</span>
            <span>
              实时更新: {worldState.ts ? new Date(worldState.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
            </span>
          </>
        )}
      </div>

      {/* 操作提示 */}
      <div className="absolute bottom-2 right-3 text-[10px] text-white/70 pointer-events-none z-10">
        滚轮缩放 · 拖拽平移 · 双击放大 · 点击实体选中
      </div>
    </div>
  );
};

export default FactoryMap;