import { axiosForBackend } from '../lib/http';

export interface ModelRecord {
  id: string;
  modelId: string;
  modelName: string;
  version: string;
  type: string;
  status: string | null;
  cardJson: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export async function listModels(): Promise<ModelRecord[]> {
  const res = await axiosForBackend({ url: '/api/models', method: 'GET' });
  return res.data;
}

export async function transitionModel(id: string, action: string): Promise<ModelRecord> {
  const res = await axiosForBackend({
    url: `/api/models/${id}/state`,
    method: 'POST',
    params: { action },
  });
  return res.data;
}
