import { axiosForBackend } from '../lib/http';

export interface AlertRecord {
  id: string;
  eventId: string;
  deviceId: string | null;
  severity: string | null;
  title: string | null;
  status: string | null;
  createdAt: string | null;
}

/**
 * 告警详情（工作台用，J2 RK-1）。
 *
 * 后端 `GET /api/alerts/:id` 返回**原始事件行**（`alert.service.ts` 直接 return row，
 * 含 orgId/schemaVersion/correlationId 等内部字段）——按设计规格补充 §2 的收窄原则，
 * 此类型只暴露 UI 允许呈现的字段，内部结构不进 UI 层。
 */
export interface AlertDetail {
  eventId: string;
  title: string | null;
  severity: string | null;
  status: string | null;
  createdAt: string | null;
  deviceId: string | null;
  /** 触发链路写入的证据快照；结构不保证稳定（首轮仅折叠键值对呈现）。 */
  evidence: Record<string, unknown> | null;
}

export async function listAlerts(): Promise<AlertRecord[]> {
  const res = await axiosForBackend({ url: '/api/alerts', method: 'GET' });
  return res.data;
}

/** 告警详情（原始行收窄；404 由调用方按 QueryState 错误态呈现）。 */
export async function getAlert(eventId: string): Promise<AlertDetail> {
  const res = await axiosForBackend({
    url: `/api/alerts/${encodeURIComponent(eventId)}`,
    method: 'GET',
  });
  const row = res.data as Record<string, unknown>;
  return {
    eventId: String(row.eventId ?? ''),
    title: (row.title as string | null) ?? null,
    severity: (row.severity as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    createdAt: (row.createdAt as string | null) ?? null,
    deviceId: (row.deviceId as string | null) ?? null,
    evidence: (row.evidenceJson as Record<string, unknown> | null) ?? null,
  };
}

export async function transitionAlert(eventId: string, action: string): Promise<AlertRecord> {
  const res = await axiosForBackend({
    url: `/api/alerts/${encodeURIComponent(eventId)}/state`,
    method: 'POST',
    params: { action },
  });
  return res.data;
}
