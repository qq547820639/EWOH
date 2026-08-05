/**
 * Wave W8「可观测性」— 诊断查询（按 requestId / user / org / page / 时间范围
 * 查询请求轨迹）。
 *
 * 后端已暴露 `GET /api/observability/traces?limit=`（返回最近的 TraceRecord 列表，
 * 见 tracing.controller / tracing.service）。当前后端未提供"按 requestId 精查"的
 * 端点，因此本模块在客户端拉取最近轨迹并做本地过滤——这是对既有接口的增量封装，
 * 不新增服务端代码。若未来后端提供精查端点，只需替换 lookup 实现，签名保持兼容。
 */

import type { TraceRecord } from '../api/tracing';

export interface TraceLookupQuery {
  requestId?: string;
  traceId?: string;
  user?: string;
  org?: string;
  page?: string;
  /** 时间范围（毫秒），仅保留 startedAt 不早于 now - timeRangeMs 的记录。 */
  timeRangeMs?: number;
  limit?: number;
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * 把 TraceLookupQuery 编译为查询字符串（供持久化/复现/分享）。
 */
export function buildTraceLookupQuery(query: TraceLookupQuery): string {
  const params = new URLSearchParams();
  if (query.requestId) params.set('requestId', query.requestId);
  if (query.traceId) params.set('traceId', query.traceId);
  if (query.user) params.set('user', query.user);
  if (query.org) params.set('org', query.org);
  if (query.page) params.set('page', query.page);
  if (query.timeRangeMs && query.timeRangeMs > 0) {
    params.set('timeRangeMs', String(query.timeRangeMs));
  }
  if (query.limit && query.limit > 0) params.set('limit', String(query.limit));
  return params.toString();
}

function matchesRequestId(record: TraceRecord, query: TraceLookupQuery): boolean {
  const needle = query.requestId ?? query.traceId;
  if (!needle) return true;
  return record.traceId === needle;
}

function matchesUser(record: TraceRecord, query: TraceLookupQuery): boolean {
  if (!query.user) return true;
  return record.path.includes(query.user);
}

function matchesOrg(record: TraceRecord, query: TraceLookupQuery): boolean {
  if (!query.org) return true;
  return record.path.includes(query.org);
}

function matchesPage(record: TraceRecord, query: TraceLookupQuery): boolean {
  if (!query.page) return true;
  return record.path.includes(query.page);
}

function withinTimeRange(record: TraceRecord, query: TraceLookupQuery): boolean {
  if (!query.timeRangeMs || query.timeRangeMs <= 0) return true;
  const cutoff = isoAgo(query.timeRangeMs);
  return record.startedAt >= cutoff;
}

/** 按查询条件过滤一条轨迹记录。 */
export function filterTraceRecord(
  record: TraceRecord,
  query: TraceLookupQuery,
): boolean {
  return (
    matchesRequestId(record, query) &&
    matchesUser(record, query) &&
    matchesOrg(record, query) &&
    matchesPage(record, query) &&
    withinTimeRange(record, query)
  );
}

/**
 * 惰性加载真实接入函数。api/tracing 静态引入会连带加载 http.ts（其 import.meta.env
 * 是 Vite 专属语法，jest CommonJS 无法解析），因此仅在无可注入 fetcher 时动态加载，
 * 保证本模块可在单测环境直接运行。
 */
async function defaultFetchTraces(limit: number): Promise<TraceRecord[]> {
  const { listRequestTraces } = await import('../api/tracing');
  return listRequestTraces(limit);
}

/**
 * 拉取最近轨迹并按查询条件过滤（含按 requestId/traceId 精查）。
 * 提供注入点便于测试；默认动态加载真实后端接口。
 */
export async function lookupTraces(
  query: TraceLookupQuery,
  fetchTraces: (limit: number) => Promise<TraceRecord[]> = defaultFetchTraces,
): Promise<TraceRecord[]> {
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const records = await fetchTraces(limit);
  return records.filter((record) => filterTraceRecord(record, query));
}

/** 便捷：按 requestId/traceId 精确查找单条轨迹。 */
export async function lookupTraceByRequestId(
  requestId: string,
  fetchTraces: (limit: number) => Promise<TraceRecord[]> = defaultFetchTraces,
): Promise<TraceRecord[]> {
  return lookupTraces({ requestId, limit: 500 }, fetchTraces);
}