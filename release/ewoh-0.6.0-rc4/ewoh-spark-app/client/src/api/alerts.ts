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

export async function listAlerts(): Promise<AlertRecord[]> {
  const res = await axiosForBackend({ url: '/api/alerts', method: 'GET' });
  return res.data;
}

export async function transitionAlert(eventId: string, action: string): Promise<AlertRecord> {
  const res = await axiosForBackend({
    url: `/api/alerts/${eventId}/state`,
    method: 'POST',
    params: { action },
  });
  return res.data;
}
