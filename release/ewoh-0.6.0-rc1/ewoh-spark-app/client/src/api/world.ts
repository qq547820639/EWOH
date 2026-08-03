import { axiosForBackend } from '../lib/http';
import type { CurrentWorldState, EventChainNode, ReplaySnapshot } from '@shared/api.interface';

export async function getWorldState(): Promise<CurrentWorldState> {
  const res = await axiosForBackend({ url: '/api/world/state', method: 'GET' });
  return res.data;
}

export async function getEventChain(eventId: string): Promise<EventChainNode[]> {
  const res = await axiosForBackend({
    url: `/api/world/events/chain/${eventId}`,
    method: 'GET',
  });
  return res.data;
}

export async function getReplay(
  from?: string,
  to?: string,
  limit = 100,
): Promise<ReplaySnapshot[]> {
  const params: Record<string, string> = { limit: String(limit) };
  if (from) params.from = from;
  if (to) params.to = to;
  const res = await axiosForBackend({ url: '/api/world/replay', method: 'GET', params });
  return res.data;
}
