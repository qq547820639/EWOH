import { axiosForBackend } from '../lib/http';

/**
 * NO-66a：设备执行边界读面（人面）。
 *
 * 平台记录了命令的完整生命周期（下发/投递确认/执行回执/授权复核撤回/未授权执行/
 * 一车一活排队/指纹方案），但此前**只有网关（机器身份）能读** —— 现场问"这台设备
 * 为什么不动"只能翻库。这里把同一份事实按租户与角色开放给值班人员。
 */
export interface DeviceCommandView {
  commandId: string;
  requestId: string;
  commandKey: string;
  attemptNo: number;
  status: string;
  /** 现场可读的投递态：awaiting_delivery / queued_device_busy / queued_quota / gateway_received / 终态 */
  deliveryState: string;
  /** NO-81a：排队原因（device_busy = 一车一活；quota = 配额用尽；null = 未排队）。 */
  queuedReason: 'device_busy' | 'quota' | null;
  deliveryNote: string | null;
  sentAt: string | null;
  responseAt: string | null;
  revokedReason: string | null;
  revokedReasonLabel: string | null;
  /** 授权指纹方案：hmac-sha256:v2（签名）/ fnv1a64:v1（一致性）/ none */
  fingerprintScheme: string;
  /** 平台是否完成过复核（v2 = 验签通过；v1 = 一致性核对通过） */
  fingerprintVerified: boolean;
  /** NO-67b：平台把命令交给网关的时刻（NULL = 从未交付）。 */
  deliveredAt?: string | null;
  ack: { delivered: boolean; reason: string | null; at: string | null } | null;
  receipt: { result: string | null; at: string | null } | null;
  violations: Array<{ resultType: string; resultCode: string | null; at: string | null }>;
  executable: boolean;
}

export interface DeviceExecutionBoundary {
  deviceId: string;
  commands: DeviceCommandView[];
  summary: {
    inFlight: number;
    queued: number;
    awaitingDelivery: number;
    revoked: number;
    busyBlocker: string | null;
    /** NO-68a：未交付命令里最久的等待时长（null = 没有待投递命令）。 */
    oldestWaitingMs?: number | null;
    /** NO-68a：超过投递 SLA 仍未交付的命令数（>0 = 存在投递积压）。 */
    overdue?: number;
    /** NO-68a：当前投递 SLA（ms）。 */
    deliverySlaMs?: number;
    /**
     * NO-67b：单设备投递配额现状（perMinute<=0 = 不限；remaining=null 表示不限）。
     * `usedInWindow` = 本轮开始前窗口内已投递条数；`remaining` = 本轮还能投几条。
     */
    quota?: { perMinute: number; usedInWindow: number; remaining: number | null };
  };
  checkedAt: string;
}

/** 读一台设备的控制命令状态（只读；服务端按租户与角色收敛）。 */
export async function getDeviceExecutionBoundary(
  deviceId: string,
  limit = 30,
): Promise<DeviceExecutionBoundary> {
  const res = await axiosForBackend({
    url: `/api/control/requests?deviceId=${encodeURIComponent(deviceId)}&limit=${limit}`,
    method: 'GET',
    timeout: 60_000,
  });
  return res.data;
}

/** NO-78a：工厂级投递积压实时快照（与巡检同一判定；服务端 5s TTL 缓存）。 */
export async function getDeliveryBacklogStatus(): Promise<DeliveryBacklogStatus> {
  const res = await axiosForBackend({
    url: '/api/control/delivery-backlog/status',
    method: 'GET',
    timeout: 60_000,
  });
  return res.data;
}

export interface DeliveryBacklogStatus {
  slaMs: number;
  escalationMultiplier: number;
  totals: {
    devices: number;
    commands: number;
    undelivered: number;
    receivedNotExecuted: number;
    escalatedDevices: number;
    oldestWaitingMs: number | null;
  };
  devices: Array<{
    deviceId: string;
    commands: number;
    undelivered: number;
    receivedNotExecuted: number;
    oldestWaitingMs: number;
    escalated: boolean;
  }>;
  /** PROJ-06：积压超过单轮检视上限 ⇒ true（totals 是真总量，devices 只覆盖最久的那一批）。 */
  truncated: boolean;
  checkedAt: string;
}

/** NO-91a：投递积压历史序列（最近在前；趋势可见漂移早发现）。 */
export interface BacklogHistoryEntry {
  checkedAt: string;
  commands: number;
  undelivered: number;
  receivedNotExecuted: number;
  escalatedDevices: number;
}

export interface DeliveryBacklogHistory {
  slaMs: number;
  escalationMultiplier: number;
  snapshots: BacklogHistoryEntry[];
}

export async function getDeliveryBacklogHistory(limit = 24): Promise<DeliveryBacklogHistory> {
  const res = await axiosForBackend({
    url: `/api/control/delivery-backlog/history?limit=${encodeURIComponent(String(limit))}`,
    method: 'GET',
    timeout: 60_000,
  });
  return res.data;
}
