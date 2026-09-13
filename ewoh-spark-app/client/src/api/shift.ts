import { axiosForBackend } from '../lib/http';
import type { ShiftDefinition, ShiftHandover, ShiftHandoverOpenItem } from '@shared/shift';

/** 班次域 API（standalone_074，DR-2 班次工作台）。 */

export async function listShifts(activeOnly = false): Promise<ShiftDefinition[]> {
  const res = await axiosForBackend({
    url: '/api/shifts',
    method: 'GET',
    params: activeOnly ? { activeOnly: 'true' } : undefined,
  });
  return res.data;
}

export interface ResolvedShift {
  current: ShiftDefinition | null;
  next: ShiftDefinition | null;
}

export async function getCurrentShift(): Promise<ResolvedShift> {
  const res = await axiosForBackend({
    url: '/api/shifts/current',
    method: 'GET',
  });
  return res.data;
}

export interface UpsertShiftInput {
  shiftId?: string;
  name: string;
  code?: string | null;
  startTime: string;
  endTime: string;
  crossesMidnight?: boolean;
  leadUserId?: string | null;
  description?: string | null;
}

export async function upsertShift(input: UpsertShiftInput): Promise<{ record: ShiftDefinition; created: boolean }> {
  const res = await axiosForBackend({
    url: '/api/shifts',
    method: 'POST',
    data: input,
  });
  return res.data;
}

export async function listHandovers(opts?: { shiftId?: string; limit?: number }): Promise<ShiftHandover[]> {
  const res = await axiosForBackend({
    url: '/api/shifts/handovers',
    method: 'GET',
    params: opts,
  });
  return res.data;
}

export interface CreateHandoverInput {
  shiftId: string;
  shiftDate?: string;
  fromUserId?: string | null;
  toUserId: string;
  openItems?: ShiftHandoverOpenItem[];
  notes?: string | null;
}

export async function createHandover(
  input: CreateHandoverInput,
): Promise<{ record: ShiftHandover; created: boolean }> {
  const res = await axiosForBackend({
    url: '/api/shifts/handovers',
    method: 'POST',
    data: input,
  });
  return res.data;
}
