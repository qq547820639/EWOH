import type { WorldStateSnapshot } from '@shared/api.interface';
import { TaskLifecycle } from './task-lifecycle';

/** 影响分类：硬冲突 / 软偏差 / 关键事件。 */
export type ImpactClass = 'hard_conflict' | 'soft_deviation' | 'critical_event';

/** 严重度。 */
export type ImpactSeverity = 'low' | 'medium' | 'high' | 'critical';

/** 统一异常/影响类型（Task 2.2.1）。 */
export type ImpactType =
  | 'RESOURCE_OFFLINE'
  | 'RESERVATION_CONFLICT'
  | 'PLAN_STALE'
  | 'ROUTE_BLOCKED'
  | 'DEVICE_OFFLINE'
  | 'DEVICE_LOW_BATTERY'
  | 'PERSON_UNAVAILABLE'
  | 'SAFETY_EVENT'
  | 'ZONE_RESTRICTED'
  | 'DEADLINE_AT_RISK';

/** 建议动作。 */
export type RecommendedAction = 'replan_partial' | 'replan_full' | 'manual_review';

/** 影响分析结果。 */
export interface ImpactResult {
  type: ImpactType;
  severity: ImpactSeverity;
  classification: ImpactClass;
  /** 需要重排的任务（直接受影响 + 下游传递，不含冻结任务）。 */
  affectedTaskIds: string[];
  /** 仅下游传递层（经 predecessor 依赖被波及的任务）。 */
  descendantTaskIds: string[];
  /** 冻结（executing/dispatched/in_progress/locked）任务。 */
  frozenTaskIds: string[];
  recommendedAction: RecommendedAction;
  canAutoReplan: boolean;
  reason: string;
}

/** 每种影响类型的元数据（严重度/分类/动作/是否可自动重排）。 */
const IMPACT_META: Record<ImpactType, Omit<ImpactResult, 'affectedTaskIds' | 'descendantTaskIds' | 'frozenTaskIds' | 'reason'>> = {
  RESOURCE_OFFLINE: {
    type: 'RESOURCE_OFFLINE',
    severity: 'high',
    classification: 'hard_conflict',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  DEVICE_OFFLINE: {
    type: 'DEVICE_OFFLINE',
    severity: 'high',
    classification: 'hard_conflict',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  RESERVATION_CONFLICT: {
    type: 'RESERVATION_CONFLICT',
    severity: 'high',
    classification: 'hard_conflict',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  ROUTE_BLOCKED: {
    type: 'ROUTE_BLOCKED',
    severity: 'high',
    classification: 'hard_conflict',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  PLAN_STALE: {
    type: 'PLAN_STALE',
    severity: 'medium',
    classification: 'soft_deviation',
    recommendedAction: 'replan_full',
    canAutoReplan: true,
  },
  PERSON_UNAVAILABLE: {
    type: 'PERSON_UNAVAILABLE',
    severity: 'medium',
    classification: 'soft_deviation',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  DEVICE_LOW_BATTERY: {
    type: 'DEVICE_LOW_BATTERY',
    severity: 'medium',
    classification: 'soft_deviation',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  DEADLINE_AT_RISK: {
    type: 'DEADLINE_AT_RISK',
    severity: 'low',
    classification: 'soft_deviation',
    recommendedAction: 'replan_partial',
    canAutoReplan: true,
  },
  SAFETY_EVENT: {
    type: 'SAFETY_EVENT',
    severity: 'critical',
    classification: 'critical_event',
    recommendedAction: 'manual_review',
    canAutoReplan: false,
  },
  ZONE_RESTRICTED: {
    type: 'ZONE_RESTRICTED',
    severity: 'critical',
    classification: 'critical_event',
    recommendedAction: 'manual_review',
    canAutoReplan: false,
  },
};

/** 输入事件形状（可来自 SchedulingEvent 或触发参数）。 */
export interface ImpactEvent {
  eventType: string;
  entityId: string | null;
}

const FROZEN_STATUSES = new Set(['executing', 'dispatched', 'in_progress']);

/**
 * 影响分析器：给定世界状态快照 + 输入事件，判定
 * 受影响任务（需重排）、冻结任务（保持不动）与下游传递任务，
 * 并区分硬冲突 / 软偏差 / 关键事件，输出建议动作与是否可自动重排。
 * 供局部重排（partial replan）裁剪求解器的输入子图。
 */
export class ImpactAnalyzer {
  analyze(snapshot: WorldStateSnapshot, event: ImpactEvent): ImpactResult {
    const raw = (event.eventType ?? '').toUpperCase();
    const type = this.normalizeType(raw);
    const meta = IMPACT_META[type] ?? IMPACT_META.PLAN_STALE;

    const lockedTaskIds = new Set(
      snapshot.lockedAssignments.map((a) => a.taskId),
    );
    const frozenTaskIds = snapshot.tasks
      .filter((t) => FROZEN_STATUSES.has(t.status) || lockedTaskIds.has(t.id))
      .map((t) => t.id);
    const frozenSet = new Set(frozenTaskIds);

    // 待处理且未冻结的任务为基础候选集。
    let candidates = snapshot.tasks.filter(
      (t) => TaskLifecycle.isSchedulable(t.status) && !frozenSet.has(t.id),
    );

    const entityId = event.entityId ?? null;
    if (entityId) {
      switch (type) {
        case 'DEVICE_OFFLINE':
        case 'DEVICE_LOW_BATTERY':
        case 'RESOURCE_OFFLINE':
          candidates = candidates.filter((t) => t.deviceId === entityId);
          break;
        case 'PERSON_UNAVAILABLE':
          candidates = candidates.filter((t) => t.assigneeId === entityId);
          break;
        case 'SAFETY_EVENT':
        case 'ZONE_RESTRICTED': {
          const forbiddenZones = new Set(
            snapshot.forbiddenZones.map((z) => z.zoneId),
          );
          candidates = candidates.filter(
            (t) => t.zoneId != null && forbiddenZones.has(t.zoneId),
          );
          break;
        }
        case 'ROUTE_BLOCKED':
          candidates = candidates.filter((t) => t.zoneId === entityId);
          break;
        case 'RESERVATION_CONFLICT':
          candidates = candidates.filter(
            (t) => t.deviceId === entityId || t.assigneeId === entityId,
          );
          break;
        // PLAN_STALE / DEADLINE_AT_RISK：entityId 为 null 时全量，此处保留全部候选。
        default:
          break;
      }
    }

    const affectedSet = new Set<string>(candidates.map((t) => t.id));
    const descendantIds = new Set<string>();

    // 下游传递：任何经 predecessorIds 依赖到受影响任务的待处理任务也纳入重排。
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of snapshot.tasks) {
        if (affectedSet.has(task.id) || frozenSet.has(task.id)) continue;
        const preds = task.predecessorIds ?? [];
        if (preds.some((p) => affectedSet.has(p))) {
          affectedSet.add(task.id);
          descendantIds.add(task.id);
          changed = true;
        }
      }
    }

    const affectedTaskIds = Array.from(affectedSet);
    const reason = `${type} impact on ${entityId ?? 'ALL'}: ${affectedTaskIds.length} affected, ${frozenTaskIds.length} frozen`;

    return {
      ...meta,
      affectedTaskIds,
      descendantTaskIds: Array.from(descendantIds),
      frozenTaskIds,
      reason,
    };
  }

  /** 将原始事件类型归一化为统一 ImpactType（未知类型回退软偏差 PLAN_STALE）。 */
  private normalizeType(raw: string): ImpactType {
    if (raw in IMPACT_META) return raw as ImpactType;
    // 兼容别名：DEVICE_OFFLINE 等已在集合内，ROUTE_BLOCKED/RESERVATION_CONFLICT 直接命中。
    return 'PLAN_STALE';
  }
}