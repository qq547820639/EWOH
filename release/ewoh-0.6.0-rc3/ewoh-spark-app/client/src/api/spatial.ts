import { axiosForBackend } from '../lib/http';
import type { SpatialEntity, Topology, SpatialHierarchyNode } from '@shared/api.interface';

export async function getEntities(
  filters?: { type?: string; parentId?: string },
): Promise<SpatialEntity[]> {
  const params: Record<string, string> = {};
  if (filters?.type) params.type = filters.type;
  if (filters?.parentId) params.parentId = filters.parentId;
  const res = await axiosForBackend({ url: '/api/spatial/entities', method: 'GET', params });
  return res.data;
}

export async function getEntity(entityId: string): Promise<SpatialEntity | null> {
  const res = await axiosForBackend({ url: `/api/spatial/entities/${entityId}`, method: 'GET' });
  return res.data;
}

export async function getTopology(): Promise<Topology[]> {
  const res = await axiosForBackend({ url: '/api/spatial/topology', method: 'GET' });
  return res.data;
}

export async function getHierarchy(): Promise<SpatialHierarchyNode[]> {
  const res = await axiosForBackend({ url: '/api/spatial/hierarchy', method: 'GET' });
  return res.data;
}
