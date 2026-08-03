import { axiosForBackend } from '../lib/http';
import type {
  DeviceInfo,
  DeviceSearchQuery,
  CreateDeviceDto,
  UpdateDeviceDto,
  DeviceBinding,
  BindDeviceRequest,
  EventInfo,
  TelemetryInfo,
  OverviewStats,
  EventStats,
  WorkerLoad,
  EnvironmentReading,
} from '@shared/api.interface';

export async function getOverview(): Promise<OverviewStats> {
  const res = await axiosForBackend({ url: '/api/dashboard/overview', method: 'GET' });
  return res.data;
}

export async function getDevices(): Promise<DeviceInfo[]> {
  const res = await axiosForBackend({ url: '/api/dashboard/devices', method: 'GET' });
  return res.data;
}

export async function searchDevices(query?: DeviceSearchQuery): Promise<DeviceInfo[]> {
  const params: Record<string, string> = {};
  if (query?.keyword) params.keyword = query.keyword;
  if (query?.online !== undefined) params.online = String(query.online);
  if (query?.batteryMin !== undefined) params.batteryMin = String(query.batteryMin);
  if (query?.batteryMax !== undefined) params.batteryMax = String(query.batteryMax);
  if (query?.sourceType) params.sourceType = query.sourceType;
  if (query?.model) params.model = query.model;
  if (query?.orderby) params.orderby = query.orderby;
  const res = await axiosForBackend({ url: '/api/dashboard/devices', method: 'GET', params });
  return res.data;
}

export async function createDevice(body: CreateDeviceDto): Promise<DeviceInfo> {
  const res = await axiosForBackend({ url: '/api/dashboard/devices', method: 'POST', data: body });
  return res.data;
}

export async function updateDevice(deviceId: string, body: UpdateDeviceDto): Promise<DeviceInfo> {
  const res = await axiosForBackend({
    url: `/api/dashboard/devices/${deviceId}`,
    method: 'PATCH',
    data: body,
  });
  return res.data;
}

export async function getDeviceBindings(deviceId: string): Promise<DeviceBinding> {
  const res = await axiosForBackend({
    url: `/api/dashboard/devices/${deviceId}/bindings`,
    method: 'GET',
  });
  return res.data;
}

export async function bindDevice(deviceId: string, body: BindDeviceRequest): Promise<DeviceBinding> {
  const res = await axiosForBackend({
    url: `/api/dashboard/devices/${deviceId}/bindings`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function unbindDevice(deviceId: string): Promise<void> {
  await axiosForBackend({
    url: `/api/dashboard/devices/${deviceId}/bindings`,
    method: 'DELETE',
  });
}

export async function getEvents(limit = 50, status?: string): Promise<EventInfo[]> {
  const params: Record<string, string> = { limit: String(limit) };
  if (status) params.status = status;
  const res = await axiosForBackend({ url: '/api/dashboard/events', method: 'GET', params });
  return res.data;
}

export async function handleEvent(
  eventId: string,
  body: { handlerAction: string; handlerNote?: string; operator?: string },
): Promise<EventInfo> {
  const res = await axiosForBackend({
    url: `/api/dashboard/events/${eventId}/handle`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function getEventStats(): Promise<EventStats> {
  const res = await axiosForBackend({ url: '/api/dashboard/events/stats', method: 'GET' });
  return res.data;
}

export async function getTelemetry(deviceId: string, limit = 50): Promise<TelemetryInfo[]> {
  const res = await axiosForBackend({
    url: `/api/dashboard/telemetry/${deviceId}`,
    method: 'GET',
    params: { limit: String(limit) },
  });
  return res.data;
}

export async function getWorkers(): Promise<WorkerLoad[]> {
  const res = await axiosForBackend({ url: '/api/dashboard/workers', method: 'GET' });
  return res.data;
}

export async function getEnvironmentSummary(): Promise<EnvironmentReading[]> {
  const res = await axiosForBackend({
    url: '/api/dashboard/environment/summary',
    method: 'GET',
  });
  return res.data;
}
