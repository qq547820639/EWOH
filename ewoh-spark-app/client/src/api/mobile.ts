import { axiosForBackend } from '../lib/http';

export interface MobileWorkbenchStep {
  stepId: string;
  scheduleTaskId: string;
  stepNo: number;
  name: string;
  instruction?: string | null;
  status: string;
  assignedPersonId: string | null;
  assignedDeviceId: string | null;
  spatialEntityId: string | null;
  progress?: number | null;
  actualStart: string | null;
  resultJson: Record<string, unknown> | null;
}

export interface MobileWorkOrderDetail {
  workOrder: {
    scheduleTaskId: string;
    title: string;
    status: string;
    progress: number;
  };
  steps: MobileWorkbenchStep[];
  materials: unknown[];
  /**
   * NO-79a：工单已派设备的**执行边界摘要**（现场问题"我的工单为什么没动"的答案）。
   * null = 未派设备或查询失败（不伪造"设备正常"）。
   */
  deviceExecution?: {
    deviceId: string;
    /** 多设备协同工单的其余派工设备（首台为主显示，其余计数展示）。 */
    otherDevices?: string[];
    inFlight: number;
    queued: number;
    awaitingDelivery: number;
    overdue: number;
    oldestWaitingMs: number | null;
    busyBlocker: string | null;
    /** NO-81a：排队原因计数——等设备空下来（device_busy）vs 等下一分钟配额（quota）。 */
    queuedReasons?: { device_busy: number; quota: number };
    /** NO-85a：协同设备中"未就绪"的聚合（排队/未交付/超时>0 即算未就绪）。 */
    otherStuckCount?: number;
    otherStuck?: Array<{ deviceId: string; queued: number; awaitingDelivery: number; overdue: number }>;
  } | null;
}

export interface MobileStepScanResult {
  scanType: 'step';
  step: MobileWorkbenchStep;
  workOrder: MobileWorkOrderDetail['workOrder'];
}

export interface MobileReferenceScanResult {
  scanType: 'device' | 'material' | 'batch' | 'station' | 'factory';
  reference: string;
  recognized: true;
  context: Record<string, unknown>;
}

export type MobileScanResult =
  | MobileWorkOrderDetail
  | MobileStepScanResult
  | MobileReferenceScanResult;

export async function getWorkbench(personId: string): Promise<MobileWorkbenchStep[]> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench?personId=${encodeURIComponent(personId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function scanWorkbench(value: string): Promise<MobileScanResult> {
  const res = await axiosForBackend({
    url: '/api/mobile/workbench/scan',
    method: 'POST',
    data: { scanValue: value },
  });
  return res.data;
}

export async function getMobileOrder(orderId: string): Promise<MobileWorkOrderDetail> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench/orders/${encodeURIComponent(orderId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function transitionMobileStep(
  orderId: string,
  stepId: string,
  action: string,
  body: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<MobileWorkbenchStep> {
  const res = await axiosForBackend({
    // CLI-708：action 改经 axios params 传参（自动 URL 编码），
    // 含 & / = / 中文等字符不再破坏 query 语义。
    url: `/api/mobile/workbench/orders/${encodeURIComponent(orderId)}/steps/${encodeURIComponent(stepId)}/state`,
    method: 'POST',
    params: { action },
    data: idempotencyKey ? { ...body, idempotencyKey } : body,
  });
  return res.data;
}

export async function inspectMobileStep(
  orderId: string,
  stepId: string,
  body: {
    result: 'pass' | 'fail' | 'rework';
    defectCode?: string;
    quantity?: number;
    note?: string;
  },
  idempotencyKey?: string,
): Promise<{ stepId: string; eventId: string; result: string }> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench/orders/${encodeURIComponent(orderId)}/steps/${encodeURIComponent(stepId)}/quality`,
    method: 'POST',
    data: idempotencyKey ? { ...body, idempotencyKey } : body,
  });
  return res.data;
}

export interface ForceResolveStepResult {
  stepId: string;
  resolution: 'local' | 'server';
  applied: boolean;
  serverValue: unknown;
  note?: string;
  resolvedAt: string;
}

/**
 * Idempotently resolves an offline step state conflict. `resolution: 'local'`
 * re-applies the local action through the authoritative state machine (never
 * bypasses it); `resolution: 'server'` keeps the current server state. The
 * backend records the decision and returns the recorded result for repeated
 * calls with the same `idempotencyKey`.
 */
export async function forceResolveMobileStep(
  orderId: string,
  stepId: string,
  body: {
    resolution: 'local' | 'server';
    idempotencyKey?: string;
    action?: string;
    payload?: Record<string, unknown>;
  },
): Promise<ForceResolveStepResult> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench/orders/${encodeURIComponent(orderId)}/steps/${encodeURIComponent(stepId)}/force-resolve`,
    method: 'POST',
    data: body,
  });
  return res.data;
}
