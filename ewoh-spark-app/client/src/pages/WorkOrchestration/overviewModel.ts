import type {
  WorkEvidence,
  WorkGate,
  WorkGraph,
  WorkItem,
  WorkResource,
  WorkRisk,
} from '../../api/work';

/** 视为「已完成」的状态关键词（不区分大小写）。 */
const DONE_STATUS = /^(done|passed|approved|closed|deployed|released|complete|delivered)$/i;

export function isDoneStatus(status: string): boolean {
  return DONE_STATUS.test(status.trim());
}

export function isIncompleteItem(item: WorkItem): boolean {
  return !isDoneStatus(item.status);
}

/** 证据「即将过期」窗口：7 天。 */
export const EXPIRING_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** 等待阈值：超过 48h 视为高优先，超过 24h 视为中优先。 */
export const LONG_WAIT_HIGH_MS = 48 * 3600 * 1000;
export const LONG_WAIT_MEDIUM_MS = 24 * 3600 * 1000;

export interface WaitingRecord {
  item: WorkItem;
  waitMs: number;
  urgency: 'high' | 'medium' | 'low';
}

export interface OverloadRecord {
  actorId: string;
  name: string;
  kind: string;
  role: string;
  load: number;
  status?: string;
}

export type NextAction =
  | { kind: 'gate'; entity: WorkGate; reason: string }
  | { kind: 'item'; entity: WorkItem; reason: string }
  | null;

export interface ExecutionOverview {
  criticalPath: string;
  /** 当前需要推进的 Gate（第一个未通过且待人类决定的门禁）。 */
  currentGate: WorkGate | null;
  /** 需要人类批准的门禁数量。 */
  gatesAwaitingApproval: number;
  /** 未完成任务（阻塞交付）。 */
  blockedItems: WorkItem[];
  blockedCount: number;
  /** 等待最长的未完成任务。 */
  longestWait: WaitingRecord[];
  longWaitCount: number;
  /** 已过期或 7 天内过期的证据。 */
  expiringEvidence: WorkEvidence[];
  expiringEvidenceCount: number;
  expiredEvidenceCount: number;
  /** 需要人类决定的开放式高风险/严重风险。 */
  needsHumanDecision: WorkRisk[];
  needsHumanDecisionCount: number;
  /** 下一项最优行动。 */
  nextAction: NextAction;
  /** 按未完成负载排序的 Actor（资源/人力过载提示）。 */
  overloaded: OverloadRecord[];
  overloadedCount: number;
  /** 锁定/缺失/冲突的资源。 */
  resourceConflicts: WorkResource[];
  resourceConflictCount: number;
  counts: {
    pending: number;
    done: number;
    gatesOpen: number;
  };
}

function parseTimestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function urgencyOf(waitMs: number): WaitingRecord['urgency'] {
  if (waitMs >= LONG_WAIT_HIGH_MS) return 'high';
  if (waitMs >= LONG_WAIT_MEDIUM_MS) return 'medium';
  return 'low';
}

/** 门禁是否「需要人类批准」。 */
function gateNeedsApproval(gate: WorkGate): boolean {
  if (isDoneStatus(gate.calculatedStatus)) return false;
  return !gate.humanDecision || gate.humanDecision === 'rejected';
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function priorityRank(item: WorkItem): number {
  const key = (item.priority ?? '').toLowerCase();
  return key in PRIORITY_RANK ? PRIORITY_RANK[key] : 4;
}

export function computeNextAction(
  graph: WorkGraph,
  currentGate: WorkGate | null,
  blockedItems: WorkItem[],
): NextAction {
  if (currentGate && gateNeedsApproval(currentGate)) {
    return {
      kind: 'gate',
      entity: currentGate,
      reason: `门禁「${currentGate.title}」尚未通过，且无有效人工决定，需要批准或驳回。`,
    };
  }
  const sortable = [...blockedItems]
    .filter(isIncompleteItem)
    .sort((a, b) => priorityRank(a) - priorityRank(b) || a.id.localeCompare(b.id));
  const next = sortable[0];
  if (next) {
    return { kind: 'item', entity: next, reason: `推进任务「${next.title}」以关闭交付缺口。` };
  }
  return null;
}

/**
 * 从 WorkGraph 推导「执行态势」重点信息，回答 7 个核心问题：
 * 当前 Gate、阻塞任务、最长等待、过期证据、待人类决策风险、下一最优行动、过载项。
 */
export function deriveExecutionOverview(graph: WorkGraph): ExecutionOverview {
  const now = Date.now();
  const items = graph.items ?? [];
  const gates = graph.gates ?? [];
  const evidence = graph.evidence ?? [];
  const risks = graph.risks ?? [];
  const actors = graph.actors ?? [];
  const resources = graph.resources ?? [];

  const openGates = gates.filter((gate) => !isDoneStatus(gate.calculatedStatus));
  const currentGate = openGates[0] ?? null;
  const gatesAwaitingApproval = openGates.filter(gateNeedsApproval).length;

  const blockedItems = items.filter(isIncompleteItem);
  const blockedCount = blockedItems.length;

  const longestWait: WaitingRecord[] = blockedItems
    .map((item) => {
      const ts = parseTimestamp(item.updatedAt) ?? parseTimestamp(graph.generatedAt) ?? now;
      const waitMs = Math.max(0, now - ts);
      return { item, waitMs, urgency: urgencyOf(waitMs) };
    })
    .sort((a, b) => b.waitMs - a.waitMs)
    .slice(0, 5);

  const expiringEvidence = evidence
    .filter((entry) => {
      const ts = parseTimestamp(entry.expiresAt);
      if (ts === null) return false;
      return ts - now <= EXPIRING_WINDOW_MS;
    })
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))
    .slice(0, 8);

  const expiredEvidenceCount = evidence.filter((entry) => {
    const ts = parseTimestamp(entry.expiresAt);
    return ts !== null && ts <= now;
  }).length;

  const needsHumanDecision = risks
    .filter(
      (risk) =>
        risk.status.toLowerCase().includes('open') &&
        (risk.severity === 'high' || risk.severity === 'critical'),
    )
    .slice(0, 8);

  const nextAction = computeNextAction(graph, currentGate, blockedItems);

  const loadByActor = new Map<string, number>();
  for (const item of blockedItems) {
    const agents = item.agents ?? (item.owner ? [item.owner] : []);
    for (const agent of agents) {
      loadByActor.set(agent, (loadByActor.get(agent) ?? 0) + 1);
    }
  }
  const overloaded: OverloadRecord[] = actors
    .map((actor) => ({
      actorId: actor.actorId,
      name: actor.name,
      kind: actor.kind,
      role: actor.role,
      load: loadByActor.get(actor.actorId) ?? 0,
      status: actor.status,
    }))
    .filter((actor) => actor.load > 0)
    .sort((a, b) => b.load - a.load)
    .slice(0, 5);

  const resourceConflicts = resources.filter(
    (resource) =>
      resource.status === 'missing' ||
      resource.status === 'locked' ||
      resource.status === 'conflict' ||
      resource.status === 'overloaded',
  );

  const doneCount = items.filter((item) => isDoneStatus(item.status)).length;

  return {
    criticalPath: graph.criticalPath ?? '',
    currentGate,
    gatesAwaitingApproval,
    blockedItems,
    blockedCount,
    longestWait,
    longWaitCount: blockedItems.length,
    expiringEvidence,
    expiringEvidenceCount: expiringEvidence.length,
    expiredEvidenceCount,
    needsHumanDecision,
    needsHumanDecisionCount: needsHumanDecision.length,
    nextAction,
    overloaded,
    overloadedCount: overloaded.length,
    resourceConflicts,
    resourceConflictCount: resourceConflicts.length,
    counts: {
      pending: blockedCount,
      done: doneCount,
      gatesOpen: openGates.length,
    },
  };
}