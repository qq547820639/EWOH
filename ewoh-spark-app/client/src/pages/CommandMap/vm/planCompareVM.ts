/* Phase 4 / P4-COMPARE 前端：Plan Compare 展示 VM。
 *
 * 输入 = 后端 PlanCompareResult（权威 diff，含 changeTypes/reasons）+
 * baseline/candidate Plan（后端方案）+
 * snapshot（坐标映射）。
 *
 * 原则：不重新判断任何业务语义（person/device/route/eta 是否变化一律使用后端
 * changeTypes）；本 VM 只做「后端 diff → 地图视觉模型」的坐标/展示装配。
 */
import type {
  PlanCompareResult,
  PlanAssignmentDiff,
  AssignmentSnapshot,
} from '@shared/api.interface';

export type PlanCompareMode = 'BASELINE' | 'CANDIDATE' | 'DIFF';

export interface PlanCompareUiState {
  baselinePlanId: string | null;
  candidatePlanId: string | null;
  mode: PlanCompareMode;
  /** 聚焦任务（点击 diff 行/地图标记时设置；null = 无聚焦）。 */
  focusedTaskId: string | null;
}

export const DEFAULT_PLAN_COMPARE_UI: PlanCompareUiState = {
  baselinePlanId: null,
  candidatePlanId: null,
  mode: 'DIFF',
  focusedTaskId: null,
};

export interface CompareMapPoint {
  x: number;
  y: number;
}

/** 地图上的 diff 实体（每个变化任务一条；before/after 坐标可分别缺失）。 */
export interface CompareMapEntry {
  taskId: string;
  changeTypes: PlanAssignmentDiff['changeTypes'];
  reasons: string[];
  before: {
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
    plannedStart: string | null;
    etaSeconds?: number | null;
    distanceMeters?: number | null;
    riskLevel?: string | null;
    point: CompareMapPoint | null;
  } | null;
  after: {
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
    plannedStart: string | null;
    etaSeconds?: number | null;
    distanceMeters?: number | null;
    riskLevel?: string | null;
    point: CompareMapPoint | null;
  } | null;
}

export interface PlanCompareMapVM {
  mode: PlanCompareMode;
  /** 变化任务（DIFF 模式渲染主体；BASELINE/CANDIDATE 模式下也可用于高亮）。 */
  entries: CompareMapEntry[];
  /** 未变化任务的 taskId（DIFF 模式下低干扰上下文）。 */
  unchangedTaskIds: string[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  churn: number;
  changeTypeCounts: Record<string, number>;
  /** 坐标查找失败的任务（不伪造位置，仅记录供 UI 提示）。 */
  missingCoordinates: string[];
}

interface CoordLookup {
  (id: string): CompareMapPoint | null;
}

function snapshotPoint(snapshot: { persons?: Array<{ id: string; x?: number | null; y?: number | null }>; stations?: Array<{ id: string; x: number; y: number }> } | null, id: string | null | undefined): CompareMapPoint | null {
  if (!id || !snapshot) return null;
  for (const p of snapshot.persons ?? []) {
    if (p.id === id && p.x != null && p.y != null) return { x: p.x, y: p.y };
  }
  for (const s of snapshot.stations ?? []) {
    if (s.id === id) return { x: s.x, y: s.y };
  }
  return null;
}

function snapshotOf(entry: PlanAssignmentDiff, mode: PlanCompareMode): AssignmentSnapshot | null {
  if (mode === 'BASELINE') return entry.before ?? null;
  if (mode === 'CANDIDATE') return entry.after ?? null;
  // DIFF：前后都有则都渲染；只显示一侧的用该侧。
  return entry.before ?? entry.after ?? null;
}

/** 纯函数：后端权威 diff → 地图展示模型（不重算资格/成本/路由）。 */
export function planCompareMapVM(
  result: PlanCompareResult,
  mode: PlanCompareMode,
  snapshot: {
    persons?: Array<{ id: string; x?: number | null; y?: number | null }>;
    stations?: Array<{ id: string; x: number; y: number }>;
  } | null,
): PlanCompareMapVM {
  const entries: CompareMapEntry[] = [];
  const unchangedTaskIds: string[] = [];
  const missingCoordinates: string[] = [];

  for (const d of result.diffByTask) {
    const beforeSnap = d.before ?? null;
    const afterSnap = d.after ?? null;

    // 展示侧坐标：DIFF 模式取「变化存在的任意一侧」用于渲染主标记。
    const displaySnap =
      mode === 'BASELINE' ? beforeSnap : mode === 'CANDIDATE' ? afterSnap : (beforeSnap ?? afterSnap);
    const displayPoint = snapshotPoint(
      snapshot,
      displaySnap?.stationId ?? displaySnap?.personId ?? null,
    );
    if (!displayPoint) missingCoordinates.push(d.taskId);

    entries.push({
      taskId: d.taskId,
      changeTypes: d.changeTypes,
      reasons: d.reasons ?? [],
      before: beforeSnap
        ? {
            personId: beforeSnap.personId ?? null,
            deviceId: beforeSnap.deviceId ?? null,
            stationId: beforeSnap.stationId ?? null,
            plannedStart: beforeSnap.plannedStart ?? null,
            etaSeconds: beforeSnap.etaSeconds ?? null,
            distanceMeters: beforeSnap.distanceMeters ?? null,
            riskLevel: beforeSnap.riskLevel ?? null,
            point: snapshotPoint(snapshot, beforeSnap.stationId ?? beforeSnap.personId ?? null),
          }
        : null,
      after: afterSnap
        ? {
            personId: afterSnap.personId ?? null,
            deviceId: afterSnap.deviceId ?? null,
            stationId: afterSnap.stationId ?? null,
            plannedStart: afterSnap.plannedStart ?? null,
            etaSeconds: afterSnap.etaSeconds ?? null,
            distanceMeters: afterSnap.distanceMeters ?? null,
            riskLevel: afterSnap.riskLevel ?? null,
            point: snapshotPoint(snapshot, afterSnap.stationId ?? afterSnap.personId ?? null),
          }
        : null,
    });
  }

  // 未变化任务：candidate 中不在 diffByTask 的 assignment。
  const diffTaskIds = new Set(result.diffByTask.map((d) => d.taskId));
  for (const t of result.removed) diffTaskIds.add(t);
  for (const t of result.added) diffTaskIds.add(t);
  // 通过 before/after snapshot 反推——此处从 result 无法直接拿全部 assignment；
  // 未变化任务由上层（面板）从 candidate plan assignments 传入，见 PlanComparePanel。

  const changeTypeCounts: Record<string, number> = {};
  for (const d of result.diffByTask) {
    for (const ct of d.changeTypes) {
      changeTypeCounts[ct] = (changeTypeCounts[ct] ?? 0) + 1;
    }
  }

  return {
    mode,
    entries,
    unchangedTaskIds,
    addedCount: result.added.length,
    removedCount: result.removed.length,
    changedCount: result.diffByTask.length,
    churn: result.churn,
    changeTypeCounts,
    missingCoordinates,
  };
}

/** 面板侧：从 candidate plan 的 assignment 提取未变化任务（DIFF 低干扰上下文）。 */
export function extractUnchangedTasks(
  result: PlanCompareResult,
  candidateAssignments: Array<{ taskId: string }>,
): string[] {
  const touched = new Set<string>();
  for (const d of result.diffByTask) touched.add(d.taskId);
  for (const t of result.added) touched.add(t);
  for (const t of result.removed) touched.add(t);
  return candidateAssignments.map((a) => a.taskId).filter((t) => !touched.has(t));
}
