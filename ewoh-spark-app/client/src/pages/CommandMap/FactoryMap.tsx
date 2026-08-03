import { useMemo } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import type { EnvironmentReading, SpatialEntity, CurrentWorldState } from '@shared/api.interface';
import { fitLabel, truncateLabel } from './labels';
import { UI_ARIA_LABELS } from '../../lib/a11y';

interface FactoryMapProps {
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  environmentReadings?: EnvironmentReading[];
  mode: string;
  level: 'L0' | 'L1';
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  replayMode: boolean;
  replayTime: string | null;
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

/** 按 mode 计算实体填充颜色 */
function getEntityColor(
  entity: SpatialEntity,
  mode: string,
  worldState: CurrentWorldState | null,
): string {
  switch (mode) {
    case 'production':
      if (entity.entityType === 'workstation') {
        if (entity.status === 'producing') return '#10b981';
        if (entity.status === 'warning') return '#f59e0b';
        return '#6b7280';
      }
      return '#3b82f6';
    case 'person':
      return entity.entityType === 'person' ? '#06b6d4' : '#4b5563';
    case 'exoskeleton':
      if (entity.entityType === 'device') {
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
      if (entity.entityType === 'zone') {
        return '#1e3a5f';
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

interface StaticStyle {
  fill: string;
  stroke: string;
  dash?: string;
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

  return (
    <div className="relative flex-1 min-w-0 bg-[hsl(220_14%_8%)] overflow-hidden">
      <TransformWrapper
        initialScale={1}
        minScale={0.5}
        maxScale={5}
        centerOnInit
        wheel={{ step: 0.1 }}
        doubleClick={{ mode: 'zoomIn', step: 0.7 }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperClass="!w-full !h-full !cursor-grab active:!cursor-grabbing"
              contentClass="!w-full !h-full"
            >
      <svg
        viewBox="0 0 1000 700"
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full"
      >
        {/* 背景点击区域：点击空白处取消选中 */}
        <rect x={0} y={0} width={1000} height={700} fill="transparent" onClick={() => onSelectEntity(null)} />

        {/* 网格背景 */}
        <defs>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x={0} y={0} width={1000} height={700} fill="url(#grid)" pointerEvents="none" />

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

        {/* 2. L1 额外层：摄像头视锥 + UWB 覆盖圈 */}
        {level === 'L1' && (
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

        {/* 3. 调度模式：连接受影响人员（简化为顺序连线） */}
        {mode === 'scheduling' && persons.length > 1 && (
          <polyline
            points={persons.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="rgba(168,85,247,0.5)"
            strokeWidth="2"
            strokeDasharray="6 4"
            pointerEvents="none"
          />
        )}

        {/* 3.5 生产模式：工位间流动虚线 + WIP 气泡 + 节拍脉冲 */}
        {mode === 'production' && flowLines.map((line, i) => (
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
        {mode === 'production' &&
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
        {devices.map((d) => {
          const online = d.status !== 'offline';
          const fill =
            mode === 'exoskeleton' || mode === 'device'
              ? online
                ? '#10b981'
                : '#6b7280'
              : online
                ? '#10b981'
                : '#6b7280';
          return (
            <g
              key={`dev-${d.entityId}`}
              onClick={() => onSelectEntity(d.entityId)}
              style={{ cursor: 'pointer' }}
            >
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
        {persons.map((p) => {
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
          }
          return (
            <g
              key={`per-${p.entityId}`}
              onClick={() => onSelectEntity(p.entityId)}
              style={{ cursor: 'pointer' }}
            >
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
        )}
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
