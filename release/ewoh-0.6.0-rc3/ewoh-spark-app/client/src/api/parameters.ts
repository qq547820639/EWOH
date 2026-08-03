import { axiosForBackend } from '../lib/http';

export type ParameterDataType =
  | 'number'
  | 'integer'
  | 'string'
  | 'boolean'
  | 'json';

export interface ParameterHistoryEntry {
  version: number;
  value: unknown;
  status: string;
  source: string;
  updatedBy: string;
  updatedAt: string;
  note?: string;
}

export interface Parameter {
  key: string;
  name: string;
  dataType: ParameterDataType;
  unit?: string;
  current: unknown;
  history: ParameterHistoryEntry[];
  status: 'draft' | 'pending' | 'active' | 'retired';
  version: number;
  source: string;
  approvalRequired: boolean;
  scope: { factoryId?: string; workCenterId?: string; deviceId?: string };
  effectiveFrom?: string;
  effectiveUntil?: string;
  validation?: { min?: number; max?: number; enum?: unknown[]; pattern?: string };
  updatedBy: string;
  updatedAt: string;
}

export interface ParameterSummary {
  totalCount: number;
  statusCounts: Record<string, number>;
  dataTypeCounts: Record<string, number>;
  expiredCount: number;
  pendingApprovalCount: number;
}

export async function listParameters(): Promise<Parameter[]> {
  const res = await axiosForBackend({ url: '/api/parameters', method: 'GET' });
  return res.data;
}

export async function registerParameter(body: {
  key: string;
  name: string;
  dataType: ParameterDataType;
  current: unknown;
  unit?: string;
  approvalRequired?: boolean;
  validation?: { min?: number; max?: number; enum?: unknown[]; pattern?: string };
  scope?: { factoryId?: string; workCenterId?: string; deviceId?: string };
}): Promise<Parameter> {
  const res = await axiosForBackend({
    url: '/api/parameters',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function updateParameter(
  key: string,
  body: { current: unknown; note?: string },
): Promise<Parameter> {
  const res = await axiosForBackend({
    url: `/api/parameters/${encodeURIComponent(key)}`,
    method: 'PUT',
    data: body,
  });
  return res.data;
}

export async function approveParameter(key: string): Promise<Parameter> {
  const res = await axiosForBackend({
    url: `/api/parameters/${encodeURIComponent(key)}/approve`,
    method: 'POST',
  });
  return res.data;
}

export async function rollbackParameter(key: string): Promise<Parameter> {
  const res = await axiosForBackend({
    url: `/api/parameters/${encodeURIComponent(key)}/rollback`,
    method: 'POST',
  });
  return res.data;
}

export async function retireParameter(key: string): Promise<Parameter> {
  const res = await axiosForBackend({
    url: `/api/parameters/${encodeURIComponent(key)}/retire`,
    method: 'POST',
  });
  return res.data;
}

export async function getParameterSummary(): Promise<ParameterSummary> {
  const res = await axiosForBackend({
    url: '/api/parameters/summary',
    method: 'GET',
  });
  return res.data;
}
