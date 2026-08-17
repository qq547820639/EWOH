/* Phase 3 / P3-T3 前端：冲突列表/生命周期展示 VM（纯函数）。
 *
 * 输入 = 后端 SchedulingConflict[]（含 P3-T1 生命周期字段 status/detectedAt/
 * acknowledgedBy/resolvedBy/suppressUntil），输出 = 前端展示模型：
 * - 按状态分组 + 严重度排序（critical > high > medium > low）；
 * - 生命周期标签（OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED）+ 可操作集合
 *   （acknowledge/resolve/suppress 的可用性由状态机决定）；
 * - 展示字段全部来自后端，前端不重算。
 */
import type { SchedulingConflict, ConflictLifecycleStatus } from '@shared/api.interface';

export type ConflictAction = 'acknowledge' | 'resolve' | 'suppress';

export interface ConflictVMItem {
  conflictId: string;
  type: SchedulingConflict['type'];
  severity: SchedulingConflict['severity'];
  scope: SchedulingConflict['scope'];
  resourceId: string | null;
  resourceType: string | null;
  taskIds: string[];
  message: string;
  resolution: string | null;
  /** 后端原始 createdAt（ISO），避免下游用 detectedAt 伪造空串（CLI-007）。 */
  createdAt: string;
  status: ConflictLifecycleStatus;
  detectedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  suppressUntil: string | null;
  planId: string | null;
  /** 当前可执行的用户操作（按 02 §6.1 状态机）。 */
  actions: ConflictAction[];
  /** 抑制中（SUPPRESSED 且未到期）→ 列表内是否仍展示（默认展示但标记）。 */
  suppressed: boolean;
}

export interface ConflictVM {
  items: ConflictVMItem[];
  byStatus: Record<ConflictLifecycleStatus, number>;
  openCount: number;
  acknowledgedCount: number;
  resolvedCount: number;
  suppressedCount: number;
  total: number;
  /** 需要人工介入（OPEN/ACKNOWLEDGED）。 */
  actionableCount: number;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** 状态机（02 §6.1）：给定状态，返回可用操作集合。 */
export function conflictActionsFor(status: ConflictLifecycleStatus): ConflictAction[] {
  switch (status) {
    case 'OPEN':
      return ['acknowledge', 'resolve', 'suppress'];
    case 'ACKNOWLEDGED':
      return ['resolve', 'suppress'];
    case 'RESOLVED':
      return [];
    case 'SUPPRESSED':
      return ['resolve'];
    default:
      return [];
  }
}

/** 纯函数：后端冲突列表 → 展示模型（排序：严重度降序，同严重度按 detectedAt 升序）。 */
export function conflictVM(conflicts: SchedulingConflict[]): ConflictVM {
  const items: ConflictVMItem[] = conflicts.map((c) => {
    const status: ConflictLifecycleStatus = c.status ?? 'OPEN';
    return {
      conflictId: c.conflictId,
      type: c.type,
      severity: c.severity,
      scope: c.scope,
      resourceId: c.resourceId ?? null,
      resourceType: c.resourceType ?? null,
      taskIds: c.taskIds ?? [],
      message: c.message,
      resolution: c.resolution ?? null,
      createdAt: c.createdAt,
      status,
      detectedAt: c.detectedAt ?? null,
      acknowledgedBy: c.acknowledgedBy ?? null,
      acknowledgedAt: c.acknowledgedAt ?? null,
      resolvedBy: c.resolvedBy ?? null,
      resolvedAt: c.resolvedAt ?? null,
      suppressUntil: c.suppressUntil ?? null,
      planId: c.planId ?? null,
      actions: conflictActionsFor(status),
      suppressed: status === 'SUPPRESSED',
    };
  });

  const sorted = [...items].sort((a, b) => {
    const sev = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (sev !== 0) return sev;
    return (a.detectedAt ?? '').localeCompare(b.detectedAt ?? '');
  });

  const byStatus: Record<ConflictLifecycleStatus, number> = {
    OPEN: 0,
    ACKNOWLEDGED: 0,
    RESOLVED: 0,
    SUPPRESSED: 0,
  };
  for (const c of sorted) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  return {
    items: sorted,
    byStatus,
    openCount: byStatus.OPEN,
    acknowledgedCount: byStatus.ACKNOWLEDGED,
    resolvedCount: byStatus.RESOLVED,
    suppressedCount: byStatus.SUPPRESSED,
    total: sorted.length,
    actionableCount: byStatus.OPEN + byStatus.ACKNOWLEDGED,
  };
}

/** 生命周期中文标签（展示用）。 */
export function conflictStatusLabel(status: ConflictLifecycleStatus): string {
  const LABELS: Record<ConflictLifecycleStatus, string> = {
    OPEN: '待处理',
    ACKNOWLEDGED: '已确认',
    RESOLVED: '已解决',
    SUPPRESSED: '已抑制',
  };
  return LABELS[status] ?? status;
}

/**
 * 显式构造（CLI-007）：ConflictVMItem → SchedulingConflict，替代调用方手工
 * 拼对象 + as 断言。createdAt 用后端原始值（不伪造空串），snapshotVersion
 * 展示模型未持有 → null（与实时冲突的「CURRENT」标记不同源，调用方按需覆盖）。
 */
export function conflictVmItemToConflict(item: ConflictVMItem): SchedulingConflict {
  return {
    conflictId: item.conflictId,
    type: item.type,
    severity: item.severity,
    scope: item.scope,
    resourceId: item.resourceId,
    resourceType: item.resourceType,
    taskIds: item.taskIds,
    message: item.message,
    resolution: item.resolution,
    createdAt: item.createdAt,
    snapshotVersion: null,
    status: item.status,
    detectedAt: item.detectedAt,
    acknowledgedBy: item.acknowledgedBy,
    acknowledgedAt: item.acknowledgedAt,
    resolvedBy: item.resolvedBy,
    resolvedAt: item.resolvedAt,
    suppressUntil: item.suppressUntil,
    planId: item.planId,
  };
}
