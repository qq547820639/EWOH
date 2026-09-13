/* 前后端共享契约 - 数据质量人工确认（standalone_076，DR-4 闭环第②步）。
 *
 * 权威契约：db/migrations/standalone_076_data_quality_confirmation.sql +
 * contracts/events/event-catalog.yaml（DataQualityConfirmed）。
 *
 * 语义：登记人对**单一事件**数据质量的最终判定。confirmed=可信、可作为决策
 * 依据；contested=不可信、相关决策需复核。判定人取服务端会话（不信任客户端
 * 自报身份）。同一事件至多一条最终判定（UNIQUE 幂等；改判=覆盖+审计）。
 */

export const DATA_QUALITY_VERDICTS = ['confirmed', 'contested'] as const;
export type DataQualityVerdict = (typeof DATA_QUALITY_VERDICTS)[number];

export interface DataQualityConfirmation {
  eventId: string;
  verdict: DataQualityVerdict;
  note?: string | null;
  /** 服务端会话身份（userId）。 */
  confirmedBy: string;
  confirmedAt: string;
  /** 判定时数据形态快照（freshness/quality 分级/来源），仅展示留痕。 */
  context?: {
    dataQuality?: string | null;
    source?: string | null;
    observedAt?: string | null;
    receivedAt?: string | null;
  } | null;
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

/** 校验确认记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateDataQualityConfirmation(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  if (typeof r.eventId !== 'string' || r.eventId.trim() === '') return ['bad_event_id'];
  if (r.verdict !== 'confirmed' && r.verdict !== 'contested') return ['unknown_verdict'];
  if (typeof r.confirmedBy !== 'string' || r.confirmedBy.trim() === '') return ['judger_required'];
  if (!isIso(r.confirmedAt)) return ['bad_confirmed_at'];
  if (r.note !== undefined && r.note !== null && typeof r.note !== 'string') return ['bad_note'];
  return [];
}
