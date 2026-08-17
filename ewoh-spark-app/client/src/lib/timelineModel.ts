/**
 * 统一对象时间线模型 —— 客户端侧模型与纯函数助手。
 *
 * 模型定义来自 shared/api.interface.ts（服务器 DTO 与客户端共享同一结构），
 * 此处仅做类型再绑定（credibility 复用 ./credibility 的 CredibilityInfo）并
 * 提供归一化 / 过滤 / 因果链构建 / 权限可见性选择等纯函数。
 */
import type {
  TimelineEvent,
  TimelineFilter,
  TimelineCredibility,
  TimelineSource,
  PermissionVisibility,
} from '@shared/api.interface';
import type { CredibilityInfo } from './credibility';

export type {
  TimelineEvent,
  TimelineFilter,
  TimelineCredibility,
  TimelineSource,
  PermissionVisibility,
  TimelineEvidenceRef,
} from '@shared/api.interface';

/** 客户端消费的统一时间线事件：credibility 绑定为本地 CredibilityInfo，便于复用 credibility 判定。 */
export type TimelineEventModel = Omit<TimelineEvent, 'credibility'> & {
  credibility: CredibilityInfo;
};

/** 归一化输入的宽松结构（允许从各类领域事件部分映射）。 */
export interface RawTimelineEvent {
  id: string;
  timestamp?: string;
  actor?: string;
  source?: TimelineSource | string;
  objectType?: string;
  objectId?: string;
  action?: string;
  previousState?: string | null;
  currentState?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  evidence?: TimelineEvent['evidence'] | Record<string, unknown> | null;
  credibility?: TimelineCredibility;
  permissionVisibility?: PermissionVisibility | string;
  severity?: string;
  title?: string;
  status?: string;
  riskLevel?: 'low' | 'medium' | 'high' | string;
  meta?: Record<string, unknown>;
  /** 兼容 createdAt / eventId 等领域字段。 */
  createdAt?: string | null;
  eventId?: string;
  eventType?: string;
  deviceId?: string;
}

const DEFAULT_SOURCE: TimelineSource = 'system';

// SH-010/016 联动：TimelineEvent.source/permissionVisibility/riskLevel 收敛
// 封闭枚举后，宽松原始输入经注册表守卫（未注册值回退安全默认，不透传任意串）。
const TIMELINE_SOURCES: ReadonlySet<string> = new Set([
  'workflow', 'alert', 'device', 'system', 'user', 'edge', 'evidence',
]);
const PERMISSION_VISIBILITIES: ReadonlySet<string> = new Set(['visible', 'restricted', 'hidden']);
const RISK_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);

function toTimelineSource(value: unknown): TimelineSource {
  return typeof value === 'string' && TIMELINE_SOURCES.has(value)
    ? (value as TimelineSource)
    : DEFAULT_SOURCE;
}

function toPermissionVisibility(value: unknown): PermissionVisibility {
  return typeof value === 'string' && PERMISSION_VISIBILITIES.has(value)
    ? (value as PermissionVisibility)
    : 'visible';
}

function toRiskLevel(value: unknown): TimelineEvent['riskLevel'] {
  return typeof value === 'string' && RISK_LEVELS.has(value)
    ? (value as TimelineEvent['riskLevel'])
    : undefined;
}

/** 将原始事件归一化为统一 TimelineEventModel（缺失字段给安全默认值）。 */
export function normalizeTimelineEvent(raw: RawTimelineEvent): TimelineEventModel {
  const timestamp = raw.timestamp ?? raw.createdAt ?? new Date().toISOString();
  const objectId = raw.objectId ?? raw.id;
  const action = raw.action ?? raw.eventType ?? 'updated';
  const source = toTimelineSource(raw.source);
  const actor = raw.actor ?? 'system';
  const credibility: CredibilityInfo = raw.credibility
    ? { ...raw.credibility }
    : { sourceType: source, decisionAuthorized: true };

  let evidence: TimelineEvent['evidence'] = [];
  if (Array.isArray(raw.evidence)) {
    evidence = raw.evidence;
  } else if (raw.evidence && typeof raw.evidence === 'object') {
    // 兼容对象形式证据（如 evidenceJson）：把每个键转成证据引用。
    evidence = Object.entries(raw.evidence).map(([key, value]) => ({
      id: key,
      label: key,
      ref: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  }

  return {
    id: raw.id,
    timestamp,
    actor,
    source,
    objectType: raw.objectType ?? 'event',
    objectId,
    action,
    previousState: raw.previousState ?? null,
    currentState: raw.currentState ?? null,
    correlationId: raw.correlationId ?? null,
    causationId: raw.causationId ?? null,
    evidence,
    credibility,
    permissionVisibility: toPermissionVisibility(raw.permissionVisibility),
    severity: raw.severity,
    title: raw.title,
    status: raw.status,
    riskLevel: toRiskLevel(raw.riskLevel),
    meta: raw.meta,
  };
}

/** 时间范围是否命中（含端）。 */
function inTimeRange(timestamp: string, from?: string, to?: string): boolean {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return true;
  if (from && new Date(from).getTime() > t) return false;
  if (to && new Date(to).getTime() < t) return false;
  return true;
}

const matches = (value: string | undefined, expected?: string): boolean =>
  !expected || (value ?? '') === expected;

/** 按 TimelineFilter 过滤统一时间线事件（不修改原数组）。 */
export function filterTimelineEvents(
  events: TimelineEventModel[],
  filter: TimelineFilter,
): TimelineEventModel[] {
  return events.filter((ev) => {
    if (!matches(ev.objectType, filter.objectType)) return false;
    if (!matches(ev.action, filter.action)) return false;
    if (!matches(ev.action, filter.eventType)) return false;
    if (!matches(ev.riskLevel, filter.riskLevel)) return false;
    if (!matches(ev.actor, filter.actor)) return false;
    if (!inTimeRange(ev.timestamp, filter.from, filter.to)) return false;
    return true;
  });
}

/**
 * 通过 correlationId / causationId 构建因果链。
 * 从 startEventId 出发，向前/向后追踪与其关联的事件（alert→decision→command→
 * execution→receipt→review），返回按时间升序的链。
 */
export function buildCorrelationChain(
  events: TimelineEventModel[],
  startEventId: string,
): TimelineEventModel[] {
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  const start = byId.get(startEventId);
  if (!start) return [];

  // CLI-530：预建关联索引，替代 BFS 内层对全量事件的线性扫描（O(n²) →
  // O(n + m)）。关联语义：某事件的 correlationId/causationId 指向另一个
  // 事件的 id。
  const byCorrelation = new Map<string, TimelineEventModel[]>();
  const byCausation = new Map<string, TimelineEventModel[]>();
  for (const ev of events) {
    if (ev.correlationId) {
      const list = byCorrelation.get(ev.correlationId) ?? [];
      list.push(ev);
      byCorrelation.set(ev.correlationId, list);
    }
    if (ev.causationId) {
      const list = byCausation.get(ev.causationId) ?? [];
      list.push(ev);
      byCausation.set(ev.causationId, list);
    }
  }

  const chain: TimelineEventModel[] = [start];
  const seen = new Set<string>([start.id]);
  const queue: TimelineEventModel[] = [start];

  while (queue.length > 0) {
    const current = queue.shift()!;
    // 指向 current 的事件（后继）。
    const successors = [
      ...(byCorrelation.get(current.id) ?? []),
      ...(byCausation.get(current.id) ?? []),
    ];
    // current 指向的事件（前驱，直接按 id 查）。
    const predecessors = [
      current.correlationId ? byId.get(current.correlationId) : undefined,
      current.causationId ? byId.get(current.causationId) : undefined,
    ];
    for (const neighbor of [...successors, ...predecessors]) {
      if (!neighbor || seen.has(neighbor.id)) continue;
      seen.add(neighbor.id);
      chain.push(neighbor);
      queue.push(neighbor);
    }
  }

  return chain.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/** 权限可见性过滤：仅保留 allowed 集合内的可见性（默认仅 visible）。 */
export function selectVisibleEvents(
  events: TimelineEventModel[],
  allowed: PermissionVisibility[] = ['visible'],
): TimelineEventModel[] {
  const allowedSet = new Set<string>(allowed);
  return events.filter((ev) => allowedSet.has(ev.permissionVisibility));
}