import { axiosForBackend } from '../lib/http';

export interface TraceRecord {
  traceId: string;
  spanId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export async function listRequestTraces(limit = 50): Promise<TraceRecord[]> {
  // CLI-720：limit 做整数与范围校验（1~500），NaN/Infinity/负数直接
  // 回退默认值，避免拼出非法 URL。
  const normalized =
    Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 50;
  const res = await axiosForBackend({
    url: `/api/observability/traces?limit=${normalized}`,
    method: 'GET',
  });
  return res.data;
}
