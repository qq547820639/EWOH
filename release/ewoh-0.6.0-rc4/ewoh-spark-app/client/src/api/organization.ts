import { axiosForBackend } from '../lib/http';
import type {
  OrganizationInfo,
  OrganizationTreeNode,
  PersonnelInfo,
  PersonnelQuery,
} from '@shared/api.interface';

export async function listOrganizations(): Promise<OrganizationInfo[]> {
  const res = await axiosForBackend({ url: '/api/organization', method: 'GET' });
  return res.data;
}

export async function getOrganizationTree(): Promise<OrganizationTreeNode[]> {
  const res = await axiosForBackend({ url: '/api/organization/tree', method: 'GET' });
  return res.data;
}

export async function listPersonnel(query?: PersonnelQuery): Promise<PersonnelInfo[]> {
  const params: Record<string, string> = {};
  if (query?.keyword) params.keyword = query.keyword;
  if (query?.orgId) params.orgId = query.orgId;
  if (query?.status) params.status = query.status;
  const res = await axiosForBackend({ url: '/api/personnel', method: 'GET', params });
  return res.data;
}

export async function getPersonnel(id: string, includeSensitive = false): Promise<PersonnelInfo> {
  const res = await axiosForBackend({
    url: includeSensitive ? `/api/personnel/${id}/sensitive` : `/api/personnel/${id}`,
    method: 'GET',
  });
  return res.data;
}
