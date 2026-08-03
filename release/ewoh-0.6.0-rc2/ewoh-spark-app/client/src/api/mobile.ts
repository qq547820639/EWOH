import { axiosForBackend } from '../lib/http';

export interface MobileWorkbenchStep {
  stepId: string;
  scheduleTaskId: string;
  stepNo: number;
  name: string;
  status: string;
  assignedPersonId: string | null;
  assignedDeviceId: string | null;
  spatialEntityId: string | null;
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

export async function getWorkbench(personId: string): Promise<MobileWorkbenchStep[]> {
  const res = await axiosForBackend({
    url: `/api/mobile/workbench?personId=${encodeURIComponent(personId)}`,
    method: 'GET',
  });
  return res.data;
}

export async function scanWorkOrder(orderId: string): Promise<MobileWorkOrderDetail> {
  const res = await axiosForBackend({
    url: '/api/mobile/workbench/scan',
    method: 'POST',
    data: { orderId },
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
