import { axiosForBackend } from '../lib/http';

export interface MaintenanceAsset {
  assetId: string;
  name: string;
  category: string;
  location: string | null;
  strategy: string;
  intervalDays: number;
  status: string;
  nextDueAt: string;
  lastCompletedAt: string | null;
  history: Array<{ status: string; at: string; actor?: string; note?: string }>;
}

export interface MaintenanceTask {
  taskId: string;
  assetId: string | null;
  title: string;
  taskType: string;
  priority: string;
  assigneeId: string | null;
  status: string;
  result: string | null;
  spareParts: Array<{ name: string; quantity: number }>;
  completedAt: string | null;
  history: Array<{ status: string; at: string; actor?: string; note?: string }>;
}

export interface MaintenanceTool {
  toolId: string;
  name: string;
  category: string;
  lifespanLimit: number | null;
  usageCount: number;
  calibrationIntervalDays: number;
  lastCalibratedAt: string | null;
  nextCalibrationAt: string;
  status: string;
  calibrationHistory: Array<{ at: string; actor?: string; note?: string }>;
}

export interface WorkCenterFlags {
  firstInspectionRequired: boolean;
  materialConsumptionRequired: boolean;
  reportReviewRequired: boolean;
  handoverRequired: boolean;
  scanRequired: boolean;
  exoskeletonRequired: boolean;
  riskConfirmationRequired: boolean;
  toolingCheckRequired: boolean;
}

export interface WorkCenter {
  workCenterId: string;
  name: string;
  location: string | null;
  capabilities: string[];
  flags: WorkCenterFlags;
  updatedBy: string | null;
  updatedAt: string;
}

export interface StandardHour {
  standardHourId: string;
  workCenterId: string;
  operationCode: string;
  operationName: string;
  standardMinutes: number;
  skillLevel: string;
  effectiveFrom: string;
  updatedAt: string;
}

export interface EfficiencyEntry {
  entryId: string;
  workerId: string;
  workCenterId: string;
  operationCode: string;
  actualMinutes: number;
  standardMinutes: number;
  deviationMinutes: number;
  efficiencyPercent: number;
  completedAt: string;
  reason: string | null;
  source: string;
  updatedAt: string;
}

export interface EfficiencySummary {
  entryCount: number;
  workerCount: number;
  averageEfficiencyPercent: number;
  fairnessStdDev: number;
  bySource: Record<string, number>;
}

export interface OperationsSummary {
  assetCount: number;
  activeAssetCount: number;
  maintenanceRequiredCount: number;
  taskCount: number;
  plannedTasks: number;
  inProgressTasks: number;
  completedTasks: number;
  cancelledTasks: number;
  toolCount: number;
  calibrationDueCount: number;
  workCenterCount: number;
  standardHourCount: number;
  efficiencyEntryCount: number;
  nextMaintenanceDue: Array<{
    assetId: string;
    name: string;
    nextDueAt: string;
  }>;
}

export async function getOperationsSummary(): Promise<OperationsSummary> {
  const res = await axiosForBackend({ url: '/api/operations/summary', method: 'GET' });
  return res.data;
}

export async function listMaintenanceAssets(): Promise<MaintenanceAsset[]> {
  const res = await axiosForBackend({ url: '/api/operations/assets', method: 'GET' });
  return res.data;
}

export async function registerMaintenanceAsset(body: {
  name: string;
  category: string;
  location?: string;
  intervalDays?: number;
}): Promise<MaintenanceAsset> {
  const res = await axiosForBackend({
    url: '/api/operations/assets',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function transitionMaintenanceAsset(
  assetId: string,
  action: 'flag_maintenance' | 'activate' | 'decommission',
): Promise<MaintenanceAsset> {
  const res = await axiosForBackend({
    url: `/api/operations/assets/${encodeURIComponent(assetId)}/state?action=${action}`,
    method: 'POST',
  });
  return res.data;
}

export async function listMaintenanceTasks(): Promise<MaintenanceTask[]> {
  const res = await axiosForBackend({ url: '/api/operations/tasks', method: 'GET' });
  return res.data;
}

export async function registerMaintenanceTask(body: {
  assetId?: string;
  title: string;
  taskType: string;
  priority?: string;
  assigneeId?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  description?: string;
}): Promise<MaintenanceTask> {
  const res = await axiosForBackend({
    url: '/api/operations/tasks',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function transitionMaintenanceTask(
  taskId: string,
  action: 'start' | 'complete' | 'cancel',
  body: { result?: string; note?: string } = {},
): Promise<MaintenanceTask> {
  const res = await axiosForBackend({
    url: `/api/operations/tasks/${encodeURIComponent(taskId)}/state?action=${action}`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listMaintenanceTools(): Promise<MaintenanceTool[]> {
  const res = await axiosForBackend({ url: '/api/operations/tools', method: 'GET' });
  return res.data;
}

export async function registerMaintenanceTool(body: {
  name: string;
  category?: string;
  lifespanLimit?: number;
  usageCount?: number;
  calibrationIntervalDays?: number;
}): Promise<MaintenanceTool> {
  const res = await axiosForBackend({
    url: '/api/operations/tools',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function transitionMaintenanceTool(
  toolId: string,
  action: 'calibrate' | 'retire',
): Promise<MaintenanceTool> {
  const res = await axiosForBackend({
    url: `/api/operations/tools/${encodeURIComponent(toolId)}/state?action=${action}`,
    method: 'POST',
  });
  return res.data;
}

export async function listWorkCenters(): Promise<WorkCenter[]> {
  const res = await axiosForBackend({ url: '/api/operations/work-centers', method: 'GET' });
  return res.data;
}

export async function upsertWorkCenter(body: {
  workCenterId?: string;
  name: string;
  location?: string;
  capabilities?: string[];
  flags?: Partial<WorkCenterFlags>;
}): Promise<WorkCenter> {
  const res = await axiosForBackend({
    url: '/api/operations/work-centers',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listStandardHours(): Promise<StandardHour[]> {
  const res = await axiosForBackend({ url: '/api/operations/standard-hours', method: 'GET' });
  return res.data;
}

export async function registerStandardHour(body: {
  workCenterId: string;
  operationCode: string;
  operationName: string;
  standardMinutes: number;
  skillLevel?: string;
}): Promise<StandardHour> {
  const res = await axiosForBackend({
    url: '/api/operations/standard-hours',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function listEfficiencyEntries(): Promise<EfficiencyEntry[]> {
  const res = await axiosForBackend({ url: '/api/operations/efficiency', method: 'GET' });
  return res.data;
}

export async function registerEfficiencyEntry(body: {
  workerId: string;
  workCenterId: string;
  operationCode: string;
  actualMinutes: number;
  standardMinutes?: number;
  completedAt?: string;
  reason?: string;
  source?: string;
}): Promise<EfficiencyEntry> {
  const res = await axiosForBackend({
    url: '/api/operations/efficiency',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function getEfficiencySummary(): Promise<EfficiencySummary> {
  const res = await axiosForBackend({
    url: '/api/operations/efficiency/summary',
    method: 'GET',
  });
  return res.data;
}

export type RoleWorkbenchRole =
  | 'operator'
  | 'team_lead'
  | 'quality'
  | 'equipment'
  | 'manager';

export async function getRoleWorkbench(
  role: RoleWorkbenchRole,
  personId?: string,
): Promise<{ role: string; generatedAt: string; data: Record<string, unknown> }> {
  const res = await axiosForBackend({
    url: '/api/operations/role-workbench',
    method: 'GET',
    params: {
      role,
      ...(personId ? { personId } : {}),
    },
  });
  return res.data;
}
