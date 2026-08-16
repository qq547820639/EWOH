// pre-approval-simulation.ts — 审批前自动布局仿真参数推导（纯函数，node 可测）。
//
// NO-12s / ADR-042：高风险计划审批前自动预验证的确定性输入面——把方案
// 的「人员移动图」推导为 layout 仿真参数（stations 坐标 + 顺序移动边，
// trips=1），由 SimulationService 的确定性布局评估器独立重算方案行程
// 成本（与求解器 walkingMeters 交叉可审计，§13 advisory 不阻断审批）。
//
// 边界（§33）：
// - 只从权威事实推导：方案分配（personId/stationId/plannedStart）+ 快照
//   工位坐标（x/y 显式 null = UNKNOWN，缺坐标的边显式跳过并计数）；
// - 无「≥2 个不同工位的移动链」→ 返回 null（调用方显式 skip 留痕，
//   绝不伪造无信息量的仿真）；
// - plannedStart 缺失的分配不参与排序（显式跳过，不猜时间）。

export interface PlanMovementAssignment {
  personId: string | null;
  stationId: string | null;
  plannedStart: string | null;
}

export interface SnapshotStation {
  id: string;
  x: number | null;
  y: number | null;
}

export interface PlanLayoutParameters {
  stations: Array<{ stationId: string; x: number; y: number }>;
  moves: Array<{ fromStationId: string; toStationId: string; trips: number }>;
  /** 因缺坐标被跳过的移动边数（显式计数，不静默吞）。 */
  missingCoordinateMoves: number;
  /** 因缺 plannedStart/personId/stationId 被跳过的分配数。 */
  skippedAssignments: number;
}

export function buildPlanLayoutParameters(
  assignments: PlanMovementAssignment[],
  snapshotStations: SnapshotStation[],
): PlanLayoutParameters | null {
  const coords = new Map<string, { x: number; y: number }>();
  for (const station of snapshotStations) {
    if (station.x != null && station.y != null) {
      coords.set(station.id, { x: station.x, y: station.y });
    }
  }

  // 按人员分组 → 按 plannedStart 排序 → 相邻不同工位 = 一条移动边。
  const byPerson = new Map<string, Array<{ stationId: string; plannedStartMs: number }>>();
  let skippedAssignments = 0;
  for (const assignment of assignments) {
    if (!assignment.personId || !assignment.stationId || !assignment.plannedStart) {
      skippedAssignments += 1;
      continue;
    }
    const startMs = new Date(assignment.plannedStart).getTime();
    if (!Number.isFinite(startMs)) {
      skippedAssignments += 1;
      continue;
    }
    const list = byPerson.get(assignment.personId) ?? [];
    list.push({ stationId: assignment.stationId, plannedStartMs: startMs });
    byPerson.set(assignment.personId, list);
  }

  const usedStations = new Set<string>();
  const moves: PlanLayoutParameters['moves'] = [];
  let missingCoordinateMoves = 0;
  for (const list of byPerson.values()) {
    list.sort((a, b) => a.plannedStartMs - b.plannedStartMs);
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1];
      const to = list[i];
      if (from.stationId === to.stationId) continue; // 同工位无移动
      if (!coords.has(from.stationId) || !coords.has(to.stationId)) {
        missingCoordinateMoves += 1;
        continue;
      }
      usedStations.add(from.stationId);
      usedStations.add(to.stationId);
      moves.push({ fromStationId: from.stationId, toStationId: to.stationId, trips: 1 });
    }
  }

  if (moves.length === 0) return null;

  const stations = [...usedStations].sort().map((stationId) => ({
    stationId,
    x: coords.get(stationId)?.x ?? 0,
    y: coords.get(stationId)?.y ?? 0,
  }));
  return { stations, moves, missingCoordinateMoves, skippedAssignments };
}
