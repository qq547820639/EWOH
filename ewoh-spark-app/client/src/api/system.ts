import { axiosForBackend } from '../lib/http';

export interface SystemConfigRecord {
  id: string;
  configKey: string;
  configValue: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: string;
}

export async function listSystemConfigs(): Promise<SystemConfigRecord[]> {
  const res = await axiosForBackend({ url: '/api/system/config', method: 'GET' });
  return res.data;
}
