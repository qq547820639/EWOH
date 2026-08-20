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

/** CLI-714：事件列表单次拉取上限——防止调用方传超大 limit 拖垮后端。 */
const MAX_EVENTS_LIMIT = 500;

/**
 * 事件列表（时间窗滚动查询，2026-08-19；2026-08-20 分页化）。
 * hours：查询最近 N 小时（默认 24h）——默认只看一天内的滚动窗口，超出后
 * 数据自动滚出视野；调用方可让用户选择时间范围（1/6/24/168h）。
 * 服务端返回 { items, total }，本函数解包返回 items（兼容既有调用方）。
 * 需要 total/翻页的调用方请用 getEventsPage。
 */
export async function getEvents(
  limit = 50,
  status?: string,
  hours = 24,
): Promise<EventInfo[]> {
  const bounded = Math.min(Math.max(1, limit), MAX_EVENTS_LIMIT);
  const params: Record<string, string> = {
    limit: String(bounded),
    hours: String(hours),
  };
  if (status) params.status = status;
  const res = await axiosForBackend({ url: '/api/dashboard/events', method: 'GET', params });
  return res.data.items;
}

/** 分页事件查询：返回 { items, total } 供翻页控件消费（offset = (page-1)*limit）。 */
export async function getEventsPage(
  limit = 20,
  status?: string,
  hours = 24,
  offset = 0,
): Promise<{ items: EventInfo[]; total: number }> {
  const bounded = Math.min(Math.max(1, limit), MAX_EVENTS_LIMIT);
  const params: Record<string, string> = {
    limit: String(bounded),
    hours: String(hours),
    offset: String(Math.max(0, Math.trunc(offset))),
  };
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
