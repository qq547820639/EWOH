/* Phase 3 / P3-T3 前端：CommandMap 纯视觉叠加层（layers）。
 *
 * 数据来源：useCommandMapSchedulerState 聚合状态（后端权威字段透传）。
 * 本文件只做 SVG 视觉叠加（坐标换算/颜色/标注），不重算调度资格、成本或优先级。
 * 每个图层组件为纯函数（props: state: CommandMapAggregate）。
 */
import React from 'react';
import type { CommandMapAggregate } from '../hooks/useCommandMapSchedulerState';

interface LayerProps {
  state: CommandMapAggregate;
}

/** 实体坐标（snapshot 的 person/device/station 已带 x/y）。 */
function pointOf(state: CommandMapAggregate, id: string): { x: number; y: number } | null {
  const s = state.snapshot;
  if (!s) return null;
  for (const p of s.persons) if (p.id === id) return p.x != null && p.y != null ? { x: p.x, y: p.y } : null;
  for (const d of s.devices) if (d.id === id) return d.x != null && d.y != null ? { x: d.x, y: d.y } : null;
  for (const st of s.stations) if (st.id === id) return { x: st.x, y: st.y };
  return null;
}

const EMPTY = null;

/** Factory Base 层：工位静态底座（数据来自 snapshot.stations，纯视觉）。 */
export function BaseLayer({ state }: LayerProps): React.ReactElement | null {
  const stations = state.snapshot?.stations ?? [];
  if (stations.length === 0) return EMPTY;
  return (
    <g data-layer="base">
      {stations.map((s) => (
        <g key={`base-${s.id}`} transform={`translate(${s.x} ${s.y})`}>
          <rect x={-14} y={-14} width={28} height={28} rx={4} fill="#1e293b" stroke="#334155" strokeWidth={1} />
          <text x={0} y={-18} textAnchor="middle" fontSize={8} fill="#94a3b8">
            {s.name}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Task 层：任务位置标记（pending/executing 区分颜色）。 */
export function TaskLayer({ state }: LayerProps): React.ReactElement | null {
  const tasks = state.snapshot?.tasks ?? [];
  if (tasks.length === 0) return EMPTY;
  const p = (id: string) => {
    const s = state.snapshot;
    const st = s?.stations.find((x) => x.id === id);
    return st ? { x: st.x, y: st.y } : null;
  };
  return (
    <g data-layer="task">
      {tasks.map((t) => {
        const pt = p(t.stationId ?? '') ?? pointOf(state, t.id);
        if (!pt) return null;
        const color = t.status === 'executing' ? '#f59e0b' : t.safetyCritical ? '#ef4444' : '#3b82f6';
        return (
          <g key={`task-${t.id}`} transform={`translate(${pt.x} ${pt.y})`}>
            <circle r={4} fill={color} stroke="#0f172a" strokeWidth={1} />
            <title>{`${t.id} ${t.status}`}</title>
          </g>
        );
      })}
    </g>
  );
}

/** Resource 层：人员/设备位置标记（状态着色）。 */
export function ResourceLayer({ state }: LayerProps): React.ReactElement | null {
  const s = state.snapshot;
  if (!s) return EMPTY;
  const persons = s.persons.map((p) => ({ id: p.id, x: p.x, y: p.y, status: p.status, name: p.name }));
  const devices = s.devices.map((d) => ({ id: d.id, x: d.x, y: d.y, status: d.status ?? 'unknown', name: d.id }));
  return (
    <g data-layer="resource">
      {persons.map((p) =>
        p.x == null || p.y == null ? null : (
          <g key={`res-${p.id}`} transform={`translate(${p.x} ${p.y})`}>
            <circle r={6} fill={p.status === 'available' ? '#22c55e' : '#f43f5e'} stroke="#0f172a" strokeWidth={1} />
            <title>{`${p.name} ${p.status}`}</title>
          </g>
        ),
      )}
      {devices.map((d) =>
        d.x == null || d.y == null ? null : (
          <g key={`res-${d.id}`} transform={`translate(${d.x} ${d.y})`}>
            <rect x={-5} y={-5} width={10} height={10} rx={2} fill={d.status === 'online' ? '#0ea5e9' : '#64748b'} stroke="#0f172a" strokeWidth={1} />
            <title>{`${d.name} ${d.status}`}</title>
          </g>
        ),
      )}
    </g>
  );
}

/** Availability 层：不可用资源高亮（stale/offline/low battery，数据来自 snapshot 字段透传）。 */
export function AvailabilityLayer({ state }: LayerProps): React.ReactElement | null {
  const s = state.snapshot;
  if (!s) return EMPTY;
  return (
    <g data-layer="availability">
      {s.persons.map((p) =>
        p.x == null || p.y == null || p.dataQuality === 'FRESH' ? null : (
          <circle key={`avail-${p.id}`} cx={p.x} cy={p.y} r={10} fill="none" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="3 2" />
        ),
      )}
      {s.devices.map((d) =>
        d.x == null || d.y == null || d.dataQuality === 'FRESH' ? null : (
          <circle key={`avail-${d.id}`} cx={d.x} cy={d.y} r={10} fill="none" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="3 2" />
        ),
      )}
    </g>
  );
}

/** Reservation 层：预占时间窗标记（资源位置 + 时间段标注，数据来自 snapshot.reservations）。 */
export function ReservationLayer({ state }: LayerProps): React.ReactElement | null {
  const reservations = state.snapshot?.reservations ?? [];
  if (reservations.length === 0) return EMPTY;
  return (
    <g data-layer="reservation">
      {reservations.map((r, i) => {
        const pt = pointOf(state, r.resourceId);
        if (!pt) return null;
        return (
          <g key={`resv-${i}`} transform={`translate(${pt.x} ${pt.y})`}>
            <circle r={11} fill="none" stroke="#a855f7" strokeWidth={1.2} />
            <title>{`${r.resourceType}:${r.resourceId} ${new Date(r.startMs).toISOString()}`}</title>
          </g>
        );
      })}
    </g>
  );
}

/** Plan 层：方案分配连线（task → person），数据来自 active plans 首个方案。 */
export function PlanLayer({ state }: LayerProps): React.ReactElement | null {
  const plan = state.plans[0];
  if (!plan) return EMPTY;
  return (
    <g data-layer="plan">
      {plan.assignments.map((a) => {
        const t = state.snapshot?.stations.find((s) => s.id === a.stationId);
        const tp = t ? { x: t.x, y: t.y } : pointOf(state, a.taskId);
        const pp = pointOf(state, a.personId ?? '');
        if (!tp || !pp) return null;
        return (
          <line
            key={`plan-${a.taskId}`}
            x1={tp.x}
            y1={tp.y}
            x2={pp.x}
            y2={pp.y}
            stroke="#38bdf8"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        );
      })}
    </g>
  );
}

/** Route 层：路由图边（数据来自 state.routes，透传 edge 坐标）。 */
export function RouteLayer({ state }: LayerProps): React.ReactElement | null {
  const graph = state.routes;
  if (!graph) return EMPTY;
  const nodeById = new Map(graph.nodes.map((n) => [n.nodeId, n]));
  return (
    <g data-layer="route">
      {graph.edges.map((e) => {
        const a = nodeById.get(e.fromNodeId);
        const b = nodeById.get(e.toNodeId);
        if (!a || !b) return null;
        return (
          <line
            key={e.edgeId}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={e.status === 'blocked' ? '#ef4444' : e.status === 'congested' ? '#f59e0b' : '#334155'}
            strokeWidth={e.status === 'blocked' ? 2 : 1}
          />
        );
      })}
    </g>
  );
}

/** Conflict 层：冲突位置标记（数据来自 conflictVM，按 severity 着色）。 */
export function ConflictLayer({ state }: LayerProps): React.ReactElement | null {
  const items = state.conflicts.items.filter((c) => c.status === 'OPEN' || c.status === 'ACKNOWLEDGED');
  if (items.length === 0) return EMPTY;
  return (
    <g data-layer="conflict">
      {items.map((c) => {
        const pt = pointOf(state, c.resourceId ?? '');
        if (!pt) return null;
        const color =
          c.severity === 'critical' ? '#ef4444' : c.severity === 'high' ? '#f97316' : '#facc15';
        return (
          <g key={`conflict-${c.conflictId}`} transform={`translate(${pt.x} ${pt.y})`}>
            <path d="M0,-8 L7,6 L-7,6 Z" fill={color} stroke="#0f172a" strokeWidth={1} />
            <title>{`${c.message} [${c.status}]`}</title>
          </g>
        );
      })}
    </g>
  );
}

/** Risk 层：高风险路由/工位高亮（route riskLevel 透传，纯视觉）。 */
export function RiskLayer({ state }: LayerProps): React.ReactElement | null {
  const graph = state.routes;
  if (!graph) return EMPTY;
  const nodeById = new Map(graph.nodes.map((n) => [n.nodeId, n]));
  return (
    <g data-layer="risk">
      {graph.edges.map((e) => {
        if (e.riskLevel !== 'high') return null;
        const a = nodeById.get(e.fromNodeId);
        const b = nodeById.get(e.toNodeId);
        if (!a || !b) return null;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <g key={`risk-${e.edgeId}`} transform={`translate(${mx} ${my})`}>
            <path d="M0,-6 L5,5 L-5,5 Z" fill="#f43f5e" />
            <title>high risk route</title>
          </g>
        );
      })}
    </g>
  );
}

/**
 * 多图层组合渲染（P0）：工厂 Base 恒在底层，其余按 activeLayers 全量叠加。
 * 同时开启 Resource + Route + Plan + Conflict 是调度驾驶舱的正常使用场景。
 */
export function SchedulerLayersOverlay({ state }: LayerProps): React.ReactElement | null {
  const active = new Set(state.ui.activeLayers);
  const layers: React.ReactElement[] = [<BaseLayer key="base" state={state} />];
  if (active.has('task')) layers.push(<TaskLayer key="task" state={state} />);
  if (active.has('resource')) layers.push(<ResourceLayer key="resource" state={state} />);
  if (active.has('availability')) layers.push(<AvailabilityLayer key="availability" state={state} />);
  if (active.has('reservation')) layers.push(<ReservationLayer key="reservation" state={state} />);
  if (active.has('plan')) layers.push(<PlanLayer key="plan" state={state} />);
  if (active.has('route')) layers.push(<RouteLayer key="route" state={state} />);
  if (active.has('conflict')) layers.push(<ConflictLayer key="conflict" state={state} />);
  if (active.has('risk')) layers.push(<RiskLayer key="risk" state={state} />);
  return <>{layers}</>;
}

export interface AggregateViewBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

/** 依据快照实体（person/device/station 点坐标）计算叠加层 viewBox（与工厂坐标系对齐，纯视觉）。 */
export function computeAggregateViewBox(state: CommandMapAggregate): AggregateViewBox {
  const fallback: AggregateViewBox = { minX: 0, minY: 0, w: 1000, h: 700 };
  const s = state.snapshot;
  if (!s) return fallback;
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of s.persons) if (p.x != null && p.y != null) pts.push({ x: p.x, y: p.y });
  for (const d of s.devices) if (d.x != null && d.y != null) pts.push({ x: d.x, y: d.y });
  for (const st of s.stations) pts.push({ x: st.x, y: st.y });
  if (pts.length === 0) return fallback;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 24;
  return {
    minX: minX - pad,
    minY: minY - pad,
    w: Math.max(maxX - minX + pad * 2, 120),
    h: Math.max(maxY - minY + pad * 2, 80),
  };
}
