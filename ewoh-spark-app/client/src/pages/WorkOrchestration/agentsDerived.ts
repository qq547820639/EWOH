import type { WorkActor, WorkEvidence, WorkHandoff, WorkItem } from '../../api/work';

/** 已完成的 item 状态集合（用于区分「未完成任务」计算负载/等待时间）。 */
const FINISHED_STATUSES = new Set([
  'done',
  'approved',
  'passed',
  'complete',
  'completed',
  'closed',
  'released',
  'merged',
  'accepted',
]);

/** 单个 Agent 基于 graph 数据推导出的增强指标。 */
export interface AgentMetrics {
  actorId: string;
  /** 名下未完成任务数（负载）。 */
  load: number;
  /** 名下关联证据中 failed 数量。 */
  failed: number;
  /** 名下关联证据总数。 */
  total: number;
  /** 失败率（failed/total），无证据时为 null。 */
  failureRate: number | null;
  /** 名下未完成任务中最长等待时间（ms），无数据时为 null。 */
  waitTimeMs: number | null;
  /** 最近一条与该 Agent 相关的交接（scope + 时间），无则为 null。 */
  recentHandoff: { scope: string; createdAt: string } | null;
}

export function isUnfinished(item: WorkItem): boolean {
  return !FINISHED_STATUSES.has((item.status ?? '').toLowerCase());
}

/** 判断一个 item 是否归属该 Agent（owner 或 agents 数组匹配）。 */
export function itemsForActor(actorId: string, items: WorkItem[]): WorkItem[] {
  return items.filter(
    (item) => item.owner === actorId || item.agents?.some((id) => id === actorId),
  );
}

/** 名下未完成任务数。 */
export function deriveLoad(actorId: string, items: WorkItem[]): number {
  return itemsForActor(actorId, items).filter(isUnfinished).length;
}

/** 名下未完成任务中最长等待时间（ms），无 updatedAt 或无未完成任务时返回 null。 */
export function deriveWaitTime(actorId: string, items: WorkItem[]): number | null {
  let max = 0;
  let has = false;
  for (const item of itemsForActor(actorId, items).filter(isUnfinished)) {
    if (!item.updatedAt) continue;
    const ms = Date.now() - Date.parse(item.updatedAt);
    if (Number.isFinite(ms) && ms > 0) {
      if (ms > max) max = ms;
      has = true;
    }
  }
  return has ? max : null;
}

/** 通过 item 归属关系，统计该 Agent 名下证据的失败数/总数。 */
export function deriveEvidence(
  actorId: string,
  items: WorkItem[],
  evidence: WorkEvidence[],
): { failed: number; total: number } {
  const owned = new Set(itemsForActor(actorId, items).map((item) => item.id));
  let failed = 0;
  let total = 0;
  for (const entry of evidence) {
    if (!owned.has(entry.workItemId)) continue;
    total += 1;
    if ((entry.result ?? '').toLowerCase() === 'failed') failed += 1;
  }
  return { failed, total };
}

/** 最近一条与该 Agent 相关的交接（fromActor 或 toActor 匹配，按 createdAt 倒序取最新）。 */
export function deriveRecentHandoff(
  actorId: string,
  handoffs: WorkHandoff[],
): AgentMetrics['recentHandoff'] {
  const latest = handoffs
    .filter((handoff) => handoff.fromActor === actorId || handoff.toActor === actorId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return latest ? { scope: latest.scope, createdAt: latest.createdAt } : null;
}

/** 为全部 Agent 批量推导增强指标。 */
export function deriveAgentMetrics(
  actors: WorkActor[],
  items: WorkItem[],
  evidence: WorkEvidence[],
  handoffs: WorkHandoff[],
): Map<string, AgentMetrics> {
  const map = new Map<string, AgentMetrics>();
  for (const actor of actors) {
    const { failed, total } = deriveEvidence(actor.actorId, items, evidence);
    map.set(actor.actorId, {
      actorId: actor.actorId,
      load: deriveLoad(actor.actorId, items),
      failed,
      total,
      failureRate: total > 0 ? failed / total : null,
      waitTimeMs: deriveWaitTime(actor.actorId, items),
      recentHandoff: deriveRecentHandoff(actor.actorId, handoffs),
    });
  }
  return map;
}