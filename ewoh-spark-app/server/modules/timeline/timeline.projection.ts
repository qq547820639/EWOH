/**
 * 统一对象时间线 —— 纯函数投影。
 *
 * 将领域事件（告警/事件记录等）映射为统一的 TimelineEvent DTO。纯函数、
 * 无副作用，便于单测与复用。服务器 DTO 与客户端共享 shared/api.interface.ts
 * 中的 TimelineEvent 结构。
 */
import type {
  TimelineEvent,
  TimelineSource,
  TimelineCredibility,
  TimelineEvidenceRef,
} from '@shared/api.interface';

/** buildTimelineEvent 可接受的领域事件输入（宽松，兼容常见事件表/API 形状）。 */
export interface TimelineBuildableEvent {
  id: string;
  /** 事件时间戳（ISO 或 Date 字符串）。 */
  timestamp?: string;
  createdAt?: string | null;
  eventId?: string;
  title?: string | null;
  severity?: string | null;
  status?: string | null;
  deviceId?: string | null;
  eventType?: string | null;
  eventCode?: string | null;
  sourceType?: string | null;
  actor?: string | null;
  /** 关联 ID（用于串链）。 */
  correlationId?: string | null;
  /** 因果 ID（父事件）。 */
  causationId?: string | null;
  /** 触发记录 ID（兼容 ewoh_event.trigger_record_id）。 */
  triggerRecordId?: string | null;
  /** 证据快照（对象形式，兼容 ewoh_event.evidence_json）。 */
  evidenceJson?: Record<string, unknown> | null;
  evidence?: TimelineEvidenceRef[];
  /** 变更前状态。 */
  previousState?: string | null;
  /** 变更后状态（缺省时可用 status 派生）。 */
  currentState?: string | null;
  [k: string]: unknown;
}

const DEFAULT_SOURCE: TimelineSource | string = 'system';

/**
 * 单个领域事件 → 统一 TimelineEvent。
 * 缺省字段给安全默认值；sourceType 同时写入 credibility.sourceType。
 */
export function buildTimelineEvent(raw: TimelineBuildableEvent): TimelineEvent {
  const timestamp = raw.timestamp ?? raw.createdAt ?? new Date().toISOString();
  const source: TimelineSource | string =
    (raw.sourceType as TimelineSource | undefined) ?? DEFAULT_SOURCE;
  const objectId = raw.deviceId ?? raw.eventId ?? raw.id;
  const action = raw.eventType ?? raw.eventCode ?? 'updated';

  const credibility: TimelineCredibility = {
    sourceType: source,
    decisionAuthorized: true,
  };

  let evidence: TimelineEvidenceRef[] = [];
  if (Array.isArray(raw.evidence)) {
    evidence = raw.evidence;
  } else if (raw.evidenceJson && typeof raw.evidenceJson === 'object') {
    evidence = Object.entries(raw.evidenceJson).map(([key, value]) => ({
      id: key,
      label: key,
      ref: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  }

  return {
    id: raw.id,
    timestamp,
    actor: raw.actor ?? 'system',
    source,
    objectType: 'event',
    objectId,
    action,
    previousState: raw.previousState ?? null,
    currentState: raw.currentState ?? raw.status ?? null,
    correlationId: raw.correlationId ?? raw.triggerRecordId ?? null,
    causationId: raw.causationId ?? null,
    evidence,
    credibility,
    permissionVisibility: 'visible',
    severity: raw.severity ?? undefined,
    title: raw.title ?? undefined,
    status: raw.status ?? undefined,
  };
}

/** 批量投影。 */
export function buildTimelineEvents(
  domainEvents: TimelineBuildableEvent[],
): TimelineEvent[] {
  return domainEvents.map(buildTimelineEvent);
}