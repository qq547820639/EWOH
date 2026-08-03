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
  const res = await axiosForBackend({
    url: `/api/observability/traces?limit=${limit}`,
    method: 'GET',
  });
  return res.data;
}
