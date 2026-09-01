import { axiosForBackend } from '../lib/http';
import type { TelemetryEvent } from '../lib/telemetry';

/**
 * UX 埋点上报与查询（J2 Gate G-1）。
 *
 * 后端落点为 `ewoh_event` 表（eventType='ux_telemetry'），无新增表与迁移。
 * 事件名白名单、批量上限、props 清洗均由服务端执行，前端只做尽力上报——
 * **任何上报失败都不得影响业务路径**。
 */

export interface TelemetryIngestResponse {
  ingested: number;
  rejected: number;
}

export interface TelemetrySummary {
  from: string;
  to: string;
  total: number;
  byName: Record<string, number>;
}

/** 批量上报；失败时抛出，由调用方吞掉。
 *
 * ⚠️ 必须用 axiosForBackend（带 Authorization，过全局 AccessTokenGuard）——
 * 裸 fetch 会 401 且被静默吞掉，导致埋点从未落库（2026-09-01 修复的实故障）。
 * 端点为 POST /api/telemetry/batch（返回 {accepted}，映射为 ingested/rejected）。
 */
export async function ingestTelemetry(
  events: TelemetryEvent[],
): Promise<TelemetryIngestResponse> {
  try {
    const res = await axiosForBackend({
      url: '/api/telemetry/batch',
      method: 'POST',
      data: {
        events: events.map((e) => ({ name: e.name, at: e.at, props: e.props })),
      },
    });
    const accepted = Number(res.data?.accepted ?? 0);
    return { ingested: accepted, rejected: events.length - accepted };
  } catch {
    // 静默：上报失败不影响业务路径（sink 侧也吞，这里双保险）。
    return { ingested: 0, rejected: events.length };
  }
}

/** 按事件名聚合查询（基线采集与指标看板用）。 */
export async function fetchTelemetrySummary(params?: {
  from?: string;
  to?: string;
}): Promise<TelemetrySummary> {
  const query = new URLSearchParams();
  if (params?.from) query.set('from', params.from);
  if (params?.to) query.set('to', params.to);
  const suffix = query.toString();
  const res = await axiosForBackend({
    url: `/api/telemetry/summary${suffix ? `?${suffix}` : ''}`,
    method: 'GET',
  });
  return res.data;
}
