import { axiosForBackend } from '../lib/http';
import type { CurrentWorldState, EventChainNode, ReplaySnapshot } from '@shared/api.interface';

export async function getWorldState(signal?: AbortSignal): Promise<CurrentWorldState> {
  const res = await axiosForBackend({
    url: '/api/world/state',
    method: 'GET',
    signal,
  });
  return res.data;
}

export async function getEventChain(eventId: string): Promise<EventChainNode[]> {
  const res = await axiosForBackend({
    url: `/api/world/events/chain/${encodeURIComponent(eventId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function getReplay(
  from?: string,
  to?: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<ReplaySnapshot[]> {
  const params: Record<string, string> = { limit: String(limit) };
  if (from) params.from = from;
  if (to) params.to = to;
  const res = await axiosForBackend({
    url: '/api/world/replay',
    method: 'GET',
    params,
    signal,
  });
  return res.data;
}

export async function getEventContext(
  eventId: string,
  windowMinutes = 10,
): Promise<Record<string, unknown>> {
  const res = await axiosForBackend({
    url: `/api/world/replay/context/${encodeURIComponent(eventId)}`,
    method: 'GET',
    params: { windowMinutes: String(windowMinutes) },
  });
  return res.data;
}

export async function createReplayItem(body: {
  eventId: string;
  kind: 'issue' | 'task' | 'evidence';
  title?: string;
  note?: string;
  replayTime?: string;
}): Promise<{ eventId: string; kind: string; title: string; createdAt: string }> {
  const res = await axiosForBackend({
    url: '/api/world/replay/items',
    method: 'POST',
    data: body,
  });
  return res.data;
}

/* ── NO-57a：订单链（订单 → 任务/工序 → 物料）消费面 ───────────────────── */

export interface OrderChainTaskDto {
  taskId: string;
  title: string;
  status: string;
  source: string;
  planStart: string | null;
  planEnd: string | null;
  stepCount: number;
  openStepCount: number;
  stepIds: string[];
}

export interface OrderChainMaterialDto {
  materialId: string;
  name: string | null;
  unit: string | null;
  requiredTotal: number;
  onHand: number;
  shortage: number;
  belowThreshold: boolean;
  orderNos: string[];
}

export interface OrderChainDto {
  orderNo: string;
  status: string;
  priority: string | null;
  dueAt: string | null;
  overdue: boolean | null;
  tasks: OrderChainTaskDto[];
  materials: OrderChainMaterialDto[];
  gaps: string[];
  assignedTaskCount: number;
  notes: string[];
}

export interface OrderChainResultDto {
  orgId: string;
  generatedAt: string;
  chains: OrderChainDto[];
  summary: {
    orders: number;
    overdue: number;
    withGaps: number;
    gapCounts: Record<string, number>;
    materialsInShortage: number;
    openSteps: number;
  };
  notes: string[];
}

/** 订单链（只读消费面；断链以 gaps 显式返回）。 */
export async function listOrderChains(
  filters: { limit?: number; orderNo?: string } = {},
): Promise<OrderChainResultDto> {
  const res = await axiosForBackend({ url: '/api/world/order-chains', method: 'GET', params: filters });
  return res.data as OrderChainResultDto;
}
