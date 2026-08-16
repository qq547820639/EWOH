/* executionDeviationMapVM.ts — 地图端执行偏差视图模型（纯映射，node 可测）。
 *
 * R-6（ADR-035）：闭合「派工后执行反馈断链」的地图端（planned vs actual）。
 * 输入 = GET /api/scheduler/executions（ewoh_scheduling_execution 权威事实）
 *      + WorldStateSnapshot（坐标事实，实体 x/y 显式 null = UNKNOWN）。
 *
 * 边界（与总提示词 §33 对齐）：
 * - 偏差分类一律使用服务端 deviationType/deviationReason，本 VM 绝不重新
 *   判定「是否偏差/何种偏差」；tone/文案仅展示层映射。
 * - 坐标只从快照解析：计划点 = 任务工位坐标（无 → 显式 null，禁止伪造 0,0）；
 *   实际点 = 执行人当前坐标（人无坐标再查设备；均无 → 显式 null）。
 * - 无数据/无坐标显式返回 empty / missingCoordinates，不静默透传 null。
 */

import type { SchedulingExecution, WorldStateSnapshot } from '@shared/scheduler';
import {
  DEVIATION_LABELS,
  EXECUTION_STATUS_LABELS,
} from './executionFeedbackVM';

/** 展示层语调：critical/warning/neutral 仅驱动颜色，不参与任何决策语义。 */
export type ExecutionDeviationTone = 'critical' | 'warning' | 'neutral';

export interface MapPoint {
  x: number;
  y: number;
}

export interface ExecutionDeviationMapEntry {
  executionId: string;
  assignmentId: string;
  taskId: string;
  personId: string | null;
  status: SchedulingExecution['status'];
  statusLabel: string;
  /** 服务端偏差类型（null = 无偏差）。 */
  deviationType: string | null;
  /** 展示层偏差文案（未知类型 → 原样透出，显式可见而非当作正常）。 */
  deviationLabel: string | null;
  deviationReason: string | null;
  tone: ExecutionDeviationTone;
  /** 计划位置：任务工位坐标（任务不在快照 → 回退 execution.stationId；均无 → null）。 */
  plannedPoint: MapPoint | null;
  /** 实际位置：执行人当前坐标（人无坐标 → 回退设备；均无 → null）。 */
  actualPoint: MapPoint | null;
  /**
   * 计划→实际偏差毫秒（按偏差类型取对应事实对）：
   * START_DELAY=actualStartAt-plannedStartAt；END_DELAY=actualEndAt-plannedEndAt；
   * TRAVEL_DELAY=actualTravelMs-plannedTravelMs；其余/事实缺失 → null。
   */
  deltaMs: number | null;
  deltaLabel: string | null;
}

export interface ExecutionDeviationMapView {
  /** 有偏差（deviationType != null）的执行——图层主体（徽标 + 计划→实际连线）。 */
  deviated: ExecutionDeviationMapEntry[];
  /** 无偏差但进行中（STARTED/PAUSED）的执行——计划→实际进度连线。 */
  ontrack: ExecutionDeviationMapEntry[];
  /** 已纳入图层但计划点或实际点坐标缺失的执行 id（不伪造位置，仅记录）。 */
  missingCoordinates: string[];
}

/**
 * 偏差类型 → 展示语调（展示层专用；未知类型 → neutral 并原样透出标签）。
 * critical：设备/安全事实；warning：时间/路线/可用性偏差；neutral：资源变更。
 */
const DEVIATION_TONES: Record<string, ExecutionDeviationTone> = {
  DEVICE_FAILURE: 'critical',
  SAFETY_INTERRUPTION: 'critical',
  START_DELAY: 'warning',
  END_DELAY: 'warning',
  TRAVEL_DELAY: 'warning',
  ROUTE_DEVIATION: 'warning',
  PERSON_UNAVAILABLE: 'warning',
  TASK_CANCELLED: 'warning',
  PERSON_CHANGED: 'neutral',
  DEVICE_CHANGED: 'neutral',
  STATION_CHANGED: 'neutral',
  MANUAL_OVERRIDE: 'neutral',
};

function fmtDelta(ms: number): string {
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${sign}${Math.round(abs / 1000)}s`;
  return `${sign}${(abs / 60_000).toFixed(1)}min`;
}

/** 快照工位坐标（x/y 显式 null = UNKNOWN → 返回 null）。 */
function stationPoint(snapshot: WorldStateSnapshot | null, stationId: string | null | undefined): MapPoint | null {
  if (!stationId || !snapshot) return null;
  const station = snapshot.stations.find((s) => s.id === stationId);
  if (!station || station.x == null || station.y == null) return null;
  return { x: station.x, y: station.y };
}

/** 执行人/设备当前坐标（人优先；均无坐标 → null）。 */
function resourcePoint(snapshot: WorldStateSnapshot | null, personId: string | null, deviceId: string | null): MapPoint | null {
  if (!snapshot) return null;
  if (personId) {
    const person = snapshot.persons.find((p) => p.id === personId);
    if (person && person.x != null && person.y != null) return { x: person.x, y: person.y };
  }
  if (deviceId) {
    const device = snapshot.devices.find((d) => d.id === deviceId);
    if (device && device.x != null && device.y != null) return { x: device.x, y: device.y };
  }
  return null;
}

/** 计划点：任务工位 →（任务缺失时）execution.stationId 回退 → null。 */
function plannedPointOf(execution: SchedulingExecution, snapshot: WorldStateSnapshot | null): MapPoint | null {
  const task = snapshot?.tasks.find((t) => t.id === execution.taskId);
  const stationId = task?.stationId ?? execution.stationId;
  return stationPoint(snapshot, stationId);
}

/** 偏差毫秒：按偏差类型取对应事实对（事实缺失/时间不可解析 → null，不猜）。 */
function deltaOf(execution: SchedulingExecution): number | null {
  const msOf = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  switch (execution.deviationType) {
    case 'START_DELAY': {
      const a = msOf(execution.actualStartAt);
      const p = msOf(execution.plannedStartAt);
      return a != null && p != null ? a - p : null;
    }
    case 'END_DELAY': {
      const a = msOf(execution.actualEndAt);
      const p = msOf(execution.plannedEndAt);
      return a != null && p != null ? a - p : null;
    }
    case 'TRAVEL_DELAY': {
      if (execution.actualTravelMs == null || execution.plannedTravelMs == null) return null;
      return execution.actualTravelMs - execution.plannedTravelMs;
    }
    default:
      return null;
  }
}

function toEntry(execution: SchedulingExecution, snapshot: WorldStateSnapshot | null): ExecutionDeviationMapEntry {
  const deviationType = execution.deviationType;
  const deltaMs = deltaOf(execution);
  return {
    executionId: execution.executionId,
    assignmentId: execution.assignmentId,
    taskId: execution.taskId,
    personId: execution.personId,
    status: execution.status,
    statusLabel: EXECUTION_STATUS_LABELS[execution.status] ?? execution.status,
    deviationType,
    deviationLabel: deviationType ? (DEVIATION_LABELS[deviationType] ?? deviationType) : null,
    deviationReason: execution.deviationReason,
    tone: deviationType ? (DEVIATION_TONES[deviationType] ?? 'neutral') : 'neutral',
    plannedPoint: plannedPointOf(execution, snapshot),
    actualPoint: resourcePoint(snapshot, execution.personId, execution.deviceId),
    deltaMs,
    deltaLabel: deltaMs != null ? fmtDelta(deltaMs) : null,
  };
}

/**
 * 执行记录 → 地图偏差视图（纯函数，保持输入顺序）。
 * 纳入范围：deviationType != null（全部状态）→ deviated；
 *           deviationType == null 且 STARTED/PAUSED → ontrack；
 *           其余（无偏差的终态/未开始记录）不渲染。
 */
export function buildExecutionDeviationMapView(input: {
  executions?: SchedulingExecution[] | null;
  snapshot?: WorldStateSnapshot | null;
}): ExecutionDeviationMapView {
  const executions = input.executions ?? [];
  const snapshot = input.snapshot ?? null;
  const deviated: ExecutionDeviationMapEntry[] = [];
  const ontrack: ExecutionDeviationMapEntry[] = [];
  const missingCoordinates: string[] = [];

  for (const execution of executions) {
    const entry = toEntry(execution, snapshot);
    const included =
      entry.deviationType != null ||
      entry.status === 'STARTED' ||
      entry.status === 'PAUSED';
    if (!included) continue;
    (entry.deviationType != null ? deviated : ontrack).push(entry);
    if (entry.plannedPoint == null || entry.actualPoint == null) {
      missingCoordinates.push(execution.executionId);
    }
  }

  return { deviated, ontrack, missingCoordinates };
}
