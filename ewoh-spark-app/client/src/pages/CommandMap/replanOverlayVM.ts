/* M05：Replan 叠加层纯选择器（changed-by-replan + human-locked，08 §10）。
 *
 * 纯函数、无 React 依赖、可 node 单测。
 * 只透传后端字段：ReplanPreviewResult.changedAssignments（changeTypes 已由服务端
 * PlanCompareService 判定）、snapshot.lockedAssignments + LOCKED_* 约束。
 * 前端不重算 hard constraints、不重算 diff —— 只做展示映射。
 */
import type {
  PlanAssignmentDiff,
  ReplanPreviewResult,
  WorldStateSnapshot,
  SchedulingConstraint,
} from '@shared/api.interface';
import { replanChangeColor, type ReplanChangeStatus } from './entityColors';

export interface ReplanChangeOverlayItem {
  taskId: string;
  status: ReplanChangeStatus;
  color: string;
  changeTypes: string[];
  reasons: string[];
}

/** 从 ReplanPreviewResult.changedAssignments 派生 changed-by-replan 集合（纯展示）。 */
export function replanChangeOverlay(
  preview: ReplanPreviewResult | null | undefined,
): Map<string, ReplanChangeOverlayItem> {
  const out = new Map<string, ReplanChangeOverlayItem>();
  if (!preview) return out;
  for (const d of preview.changedAssignments ?? []) {
    const status = diffStatus(d);
    out.set(d.taskId, {
      taskId: d.taskId,
      status,
      color: replanChangeColor(status),
      changeTypes: d.changeTypes ?? [],
      reasons: d.reasons ?? [],
    });
  }
  return out;
}

/** 单条 diff → ReplanChangeStatus（服务端 changeTypes 已判定，前端只映射）。 */
export function diffStatus(d: PlanAssignmentDiff): ReplanChangeStatus {
  const types = d.changeTypes ?? [];
  if (types.includes('REMOVED')) return 'REMOVED';
  if (types.includes('ADDED')) return 'ADDED';
  if (types.length > 0) return 'MOVED';
  return 'UNCHANGED';
}

/** human-locked 任务集合：snapshot.lockedAssignments + LOCKED_* 约束（纯展示）。 */
export function humanLockedTaskIds(
  snapshot: WorldStateSnapshot | null | undefined,
  constraints: SchedulingConstraint[] | null | undefined = [],
): Set<string> {
  const ids = new Set<string>();
  for (const la of snapshot?.lockedAssignments ?? []) {
    if (la.taskId) ids.add(la.taskId);
  }
  const LOCKED_TYPES = new Set([
    'LOCKED_PERSON',
    'LOCKED_DEVICE',
    'LOCKED_STATION',
    'LOCKED_TIME',
    'LOCKED_ASSIGNMENT',
  ]);
  for (const c of constraints ?? []) {
    if (c.taskId && LOCKED_TYPES.has(c.type)) ids.add(c.taskId);
  }
  return ids;
}
