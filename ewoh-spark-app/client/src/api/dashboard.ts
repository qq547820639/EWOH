import { axiosForBackend } from '../lib/http';
import {
  DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE,
  buildCapabilityRestoreApprovalSubject,
} from '@shared/capability-requirements';
import type {
  BindDeviceRequest,
  CreateDeviceDto,
  DeviceBinding,
  DeviceInfo,
  DeviceSearchQuery,
  EnvironmentReading,
  EventInfo,
  EventStats,
  OverviewStats,
  SetDeviceCapabilityStatusRequest,
  SetDeviceCapabilityStatusResponse,
  TelemetryInfo,
  UpdateDeviceDto,
  WorkerLoad,
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
  if (query?.category) params.category = query.category;
  if (query?.model) params.model = query.model;
  if (query?.orderby) params.orderby = query.orderby;
  const res = await axiosForBackend({ url: '/api/dashboard/devices', method: 'GET', params });
  return res.data;
}

/**
 * 设备详情（含能力清单）。
 *
 * 路由说明（真实后端 E2E 抓到 2026-09-10）：详情只有 `/api/devices/:id`
 * （DeviceContractController → DashboardService，与 dashboard 同源），
 * dashboard 控制器**没有** `devices/:id` 详情路由——此前写错路径，
 * mock 用例因为拦截的是 mock 自己的路径而未能发现。
 */
export async function getDeviceDetail(deviceId: string): Promise<DeviceInfo> {
  const res = await axiosForBackend({
    url: `/api/devices/${encodeURIComponent(deviceId)}`,
    method: 'GET',
  });
  return res.data;
}

/**
 * 人工停用 / 恢复设备能力（唯一人工写入口；理由必填，后端 fail-closed 校验）。
 * 返回体含 changed（幂等 no-op 时为 false）与 contractValid。
 */
export async function setDeviceCapabilityStatus(
  deviceId: string,
  capabilityName: string,
  body: SetDeviceCapabilityStatusRequest,
): Promise<SetDeviceCapabilityStatusResponse> {
  const res = await axiosForBackend({
    url: `/api/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(capabilityName)}/status`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

/**
 * NO-21b：为"恢复高风险设备能力"发起安全管理员审批。
 *
 * 与任务侧（`requestCapabilityRelaxationApproval`）同一套审批模块，只是 entityType 换成
 * `device_capability_change`、entityId 换成 `capability:<能力名>`；一次审批可覆盖一批设备
 * （subject.metrics.deviceIds 为排序后的逗号列表，后端逐字核对指纹）。
 */
export async function requestDeviceCapabilityRestoreApproval(params: {
  capabilityKey: string;
  deviceIds: string[];
  reason?: string | null;
}): Promise<{
  id: string;
  status: string;
  /** NO-22a：通过时间（时效展示；新建时为 undefined）。 */
  approvedAt?: string;
  steps?: Array<{ id: string; role: string; status: string }>;
}> {
  const subject = buildCapabilityRestoreApprovalSubject(params);
  const res = await axiosForBackend({
    url: '/api/approvals',
    method: 'POST',
    data: {
      entityType: DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE,
      entityId: subject.objectId,
      roles: ['safety_admin'],
      subject,
    },
  });
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


/* ── NO-57b：预计 vs 实际 对账（只读口径）──────────────────────────────── */

export interface PlannedVsActualSummaryDto {
  windowDays: number;
  totalRows: number;
  comparableRows: number;
  coverage: number | null;
  meanAbsPctError: number | null;
  medianAbsPctError: number | null;
  p90AbsPctError: number | null;
  meanSignedMs: number | null;
  overrunCount: number;
  underrunCount: number;
  onTimeCount: number;
  byReason: Record<string, number>;
  byDeviationType: Record<string, number>;
  biasNote: string | null;
  notes: string[];
  generatedAt: string;
}

/** 执行事实的对账口径（样本不足时比率字段为 null，页面必须显示"证据不足"）。 */
export async function getPlannedVsActual(windowDays = 30): Promise<PlannedVsActualSummaryDto> {
  const res = await axiosForBackend({
    url: '/api/scheduler/planned-vs-actual',
    method: 'GET',
    params: { windowDays },
  });
  return res.data as PlannedVsActualSummaryDto;
}
