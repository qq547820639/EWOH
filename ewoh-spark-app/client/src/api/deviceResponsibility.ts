import { axiosForBackend } from '../lib/http';

/**
 * 设备责任人 API（NO-49a 后端 / NO-50a 页面）。
 *
 * 页面需要两类读：①批量（台账表格，一次拿一页的责任关系，避免 N+1）；
 * ②单台（责任人对话框）。两者都按 org + 可见性作用域由服务端收口。
 */
export const DEVICE_RESPONSIBILITY_KINDS = ['owner', 'operator', 'maintainer'] as const;
export type DeviceResponsibilityKind = (typeof DEVICE_RESPONSIBILITY_KINDS)[number];

export interface DeviceResponsibilityRecord {
  deviceId: string;
  personId: string;
  responsibility: DeviceResponsibilityKind;
  /** 适用班次；空串 = 全天（NO-51a）。 */
  shiftId: string;
  active: boolean;
  note: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
}

/** 批量读（deviceIds 为空 = 本租户全部 active 责任关系）。 */
export async function listDeviceResponsibilities(deviceIds: string[] = []): Promise<DeviceResponsibilityRecord[]> {
  const res = await axiosForBackend({
    url: '/api/device-responsibilities',
    method: 'GET',
    params: deviceIds.length > 0 ? { deviceIds: deviceIds.join(',') } : undefined,
  });
  return Array.isArray(res.data) ? (res.data as DeviceResponsibilityRecord[]) : [];
}

/** 设置责任人（同一职责换人 = 旧行停用 + 新行启用）。 */
export async function setDeviceResponsibility(
  deviceId: string,
  body: { personId: string; responsibility: DeviceResponsibilityKind; shiftId?: string; note?: string },
): Promise<DeviceResponsibilityRecord> {
  const res = await axiosForBackend({
    url: `/api/devices/${encodeURIComponent(deviceId)}/responsibilities`,
    method: 'POST',
    data: body,
  });
  return res.data as DeviceResponsibilityRecord;
}

/** 收回责任人（不存在 active 持有人 → 服务端 409）。 */
export async function clearDeviceResponsibility(
  deviceId: string,
  responsibility: DeviceResponsibilityKind,
  options: { shiftId?: string; reason?: string } = {},
): Promise<Record<string, unknown>> {
  const res = await axiosForBackend({
    url: `/api/devices/${encodeURIComponent(deviceId)}/responsibilities/${encodeURIComponent(responsibility)}`,
    method: 'DELETE',
    params: {
      ...(options.shiftId ? { shiftId: options.shiftId } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    },
  });
  return res.data as Record<string, unknown>;
}

/* ── NO-52a：交接班前的责任人核对 ─────────────────────────────────────── */

export interface ResponsibilityCoverageDevice {
  deviceId: string;
  holders: Array<{ personId: string; responsibility: DeviceResponsibilityKind; matchedBy: 'current_shift' | 'all_shift' }>;
  outOfShift: Array<{ personId: string; responsibility: DeviceResponsibilityKind; shiftId: string }>;
  covered: boolean;
}

export interface ResponsibilityCoverageSnapshot {
  shiftId: string | null;
  shiftUnknown: boolean;
  total: number;
  covered: number;
  gaps: number;
  uncovered: number;
  devices: ResponsibilityCoverageDevice[];
  notes: string[];
}

/** 给定班次的责任人核对快照（不传 shiftId = 用当前班次）。 */
export async function getResponsibilityCoverage(shiftId?: string | null): Promise<ResponsibilityCoverageSnapshot> {
  const res = await axiosForBackend({
    url: '/api/device-responsibilities/coverage',
    method: 'GET',
    params: shiftId === undefined ? undefined : { shiftId: shiftId ?? '' },
  });
  return res.data as ResponsibilityCoverageSnapshot;
}
