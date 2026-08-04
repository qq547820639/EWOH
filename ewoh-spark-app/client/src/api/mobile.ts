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
): Promise<MobileWorkbenchStep> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench/orders/${encodeURIComponent(orderId)}/steps/${encodeURIComponent(stepId)}/state?action=${action}`,
    method: 'POST',
    data: body,
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
): Promise<{ stepId: string; eventId: string; result: string }> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench/orders/${encodeURIComponent(orderId)}/steps/${encodeURIComponent(stepId)}/quality`,
    method: 'POST',
    data: body,
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
