/* 前后端共享契约 - Canonical Event Envelope（ADR-009 / NO-04）。
 *
 * 权威契约：contracts/events/envelope.schema.json + envelope-test-vectors.json。
 * 语义与 src/edge_platform/contracts/envelope.py 逐项一致（共享向量约束）：
 * 时间三态 occurredAt ≤ observedAt ≤ receivedAt（漂移容忍 5min，标记 clockDrift
 * 不改写）；迟到标记不丢弃；actor/subject 规范身份；confidence [0,1]；
 * (source, eventId) 重放幂等。
 */

import { isCanonicalIdentity } from './identity';
import { DomainContractError } from './risk';

export const ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS = 300_000;
export const ENVELOPE_LATE_THRESHOLD_MS = 600_000;
export const ENVELOPE_REQUIRED_FIELDS = ['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'source'] as const;

export interface EventEnvelope {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  occurredAt: string;
  source: string;
  observedAt?: string | null;
  receivedAt?: string | null;
  tenantId?: string | null;
  factoryId?: string | null;
  actor?: string | null;
  subject?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
  confidence?: number | null;
  payload?: Record<string, unknown> | null;
  evidence?: unknown[] | null;
}

export function parseEnvelopeTs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim();
  if (text.endsWith('Z')) text = `${text.slice(0, -1)}+00:00`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/** 校验信封；返回错误码列表（空 = 合法）。knownEventTypes 来自事件目录（fail-closed）。 */
export function validateEventEnvelope(
  envelope: unknown,
  knownEventTypes: ReadonlySet<string>,
): string[] {
  if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return ['record_must_be_object'];
  }
  const e = envelope as Record<string, unknown>;
  if (typeof e.eventType !== 'string' || e.eventType === '') return ['missing_event_type'];
  for (const field of ENVELOPE_REQUIRED_FIELDS) {
    if (!(field in e)) return [`missing_field:${field}`];
  }
  if (typeof e.eventId !== 'string' || e.eventId === '') return ['bad_event_id'];
  if (!knownEventTypes.has(e.eventType)) return ['unknown_event_type'];
  if (typeof e.schemaVersion !== 'string' || e.schemaVersion === '') return ['bad_schema_version'];
  if (parseEnvelopeTs(e.occurredAt) == null) return ['bad_occurred_at'];
  if (typeof e.source !== 'string' || e.source === '') return ['bad_source'];
  if (e.observedAt != null && parseEnvelopeTs(e.observedAt) == null) return ['bad_observed_at'];
  if (e.receivedAt != null && parseEnvelopeTs(e.receivedAt) == null) return ['bad_received_at'];
  for (const refKey of ['actor', 'subject']) {
    const ref = e[refKey];
    if (ref != null && (typeof ref !== 'string' || !isCanonicalIdentity(ref))) {
      return [`bad_${refKey}`];
    }
  }
  if (e.confidence != null) {
    const c = e.confidence as number;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return ['bad_confidence'];
  }
  return [];
}

/** 时间语义画像：clockDrift / isLate（先决：信封已通过 validateEventEnvelope）。 */
export function envelopeSemantics(envelope: Record<string, unknown>): { clockDrift: boolean; isLate: boolean } {
  const occurred = parseEnvelopeTs(envelope.occurredAt) ?? 0;
  const observed = envelope.observedAt != null ? parseEnvelopeTs(envelope.observedAt) : null;
  const received = envelope.receivedAt != null ? parseEnvelopeTs(envelope.receivedAt) : null;
  let clockDrift = false;
  if (observed != null && occurred - observed > ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS) clockDrift = true;
  if (received != null && occurred - received > ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS) clockDrift = true;
  if (observed != null && received != null && observed - received > ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS) clockDrift = true;
  const isLate = received != null && received - occurred > ENVELOPE_LATE_THRESHOLD_MS;
  return { clockDrift, isLate };
}

export function envelopeDedupKey(envelope: Record<string, unknown>): string {
  return `${String(envelope.source)}|${String(envelope.eventId)}`;
}

/** NO-04b：云侧事件写路径的信封构建（occurred/observed/received 同刻为云侧本地生成事件）。 */
export function buildEventEnvelope(opts: {
  eventId: string;
  eventType: string;
  occurredAt: string;
  observedAt?: string;
  receivedAt: string;
  source: string;
  schemaVersion?: string;
  tenantId?: string | null;
  factoryId?: string | null;
  actor?: string | null;
  subject?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
  confidence?: number | null;
  payload?: Record<string, unknown> | null;
  evidence?: unknown[] | null;
}): EventEnvelope {
  return {
    eventId: opts.eventId,
    eventType: opts.eventType,
    schemaVersion: opts.schemaVersion ?? '1.0.0',
    occurredAt: opts.occurredAt,
    observedAt: opts.observedAt ?? null,
    receivedAt: opts.receivedAt,
    tenantId: opts.tenantId ?? null,
    factoryId: opts.factoryId ?? null,
    actor: opts.actor ?? null,
    subject: opts.subject ?? null,
    causationId: opts.causationId ?? null,
    correlationId: opts.correlationId ?? null,
    confidence: opts.confidence ?? null,
    payload: opts.payload ?? null,
    evidence: opts.evidence ?? null,
    source: opts.source,
  };
}

/** NO-04b：把信封及其时间语义附着到 evidenceJson（兼容层：不破坏既有列语义）。 */
export function envelopeForEvidence(envelope: EventEnvelope): {
  envelope: EventEnvelope;
  envelopeSemantics: { clockDrift: boolean; isLate: boolean };
} {
  return {
    envelope,
    envelopeSemantics: envelopeSemantics(envelope as unknown as Record<string, unknown>),
  };
}
