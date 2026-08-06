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

export interface RoleWorkbenchResponse {
  role: string;
  generatedAt: string;
  /** Workbench roles the authenticated user is allowed to view (server-computed). */
  authorizedRoles: RoleWorkbenchRole[];
  /** Server-granted debug/diagnostics permission (never from localStorage). */
  canDebug: boolean;
  /** True when viewing a role that is not the user's own default (admin simulate). */
  simulating: boolean;
  data: Record<string, unknown>;
}

export async function getRoleWorkbench(
  role: RoleWorkbenchRole,
  personId?: string,
): Promise<RoleWorkbenchResponse> {
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

// ===== 角色工作台：服务端分页/筛选/排序 =====
export interface WorkbenchListQuery {
  page?: number;
  pageSize?: number;
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
}

export interface WorkbenchListResult<T = Record<string, unknown>> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Server-computed status of this list query ('ok' or a degraded marker). */
  status?: string;
  /** Server timestamp of the freshest data that produced this page. */
  dataFreshness?: string;
  hasNextPage?: boolean;
  nextCursor?: string | null;
}

export async function getWorkbenchList(
  role: RoleWorkbenchRole,
  listKey: string,
  query: WorkbenchListQuery = {},
  personId?: string,
): Promise<WorkbenchListResult> {
  const res = await axiosForBackend({
    url: '/api/operations/workbench/list',
    method: 'GET',
    params: {
      role,
      listKey,
      ...query,
      ...(personId ? { personId } : {}),
    },
  });
  return res.data;
}

// ===== 角色工作台：异步大数导出任务 =====
export type WorkbenchExportStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'expired';

export interface WorkbenchExportTask {
  id: string;
  role: RoleWorkbenchRole;
  listKey: string;
  filter: string;
  status: WorkbenchExportStatus;
  progress: number;
  processed: number;
  total: number;
  ownerId: string;
  orgId: string;
  action: string;
  createdAt: string;
  expiresAt: string;
  downloadUrl?: string;
  error?: string;
}

export async function createWorkbenchExport(
  role: RoleWorkbenchRole,
  listKey: string,
  filter = '',
): Promise<WorkbenchExportTask> {
  const res = await axiosForBackend({
    url: '/api/operations/workbench/export',
    method: 'POST',
    data: { role, listKey, filter },
  });
  return res.data;
}

export async function getWorkbenchExportTask(
  id: string,
): Promise<WorkbenchExportTask> {
  const res = await axiosForBackend({
    url: `/api/operations/workbench/export/${encodeURIComponent(id)}`,
    method: 'GET',
  });
  return res.data;
}

// ===== 角色工作台：保存视图服务端持久化 / 跨设备 / 共享 =====
export interface WorkbenchView {
  key: string;
  role: string;
  listKey: string;
  ownerId: string;
  orgId: string;
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchViewInput {
  role: string;
  listKey: string;
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  shared?: boolean;
}

export async function saveWorkbenchView(
  key: string,
  body: WorkbenchViewInput,
): Promise<WorkbenchView> {
  const res = await axiosForBackend({
    url: `/api/operations/workbench/views/${encodeURIComponent(key)}`,
    method: 'PUT',
    data: body,
  });
  return res.data;
}

export async function listWorkbenchViews(): Promise<WorkbenchView[]> {
  const res = await axiosForBackend({
    url: '/api/operations/workbench/views',
    method: 'GET',
  });
  return res.data;
}

export async function deleteWorkbenchView(key: string): Promise<void> {
  await axiosForBackend({
    url: `/api/operations/workbench/views/${encodeURIComponent(key)}`,
    method: 'DELETE',
  });
}

// ===== 危险操作：影响预览 / 幂等确认 / 撤销补偿 =====
export type DangerousActionKind =
  | 'transfer'
  | 'approve'
  | 'delete'
  | 'cancel'
  | 'resolve';

export interface DangerousImpact {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  summary: string;
  affectedCount: number;
  irreversible: boolean;
  requiresConfirmation: boolean;
}

export interface DangerousConfirmResult {
  actionId: string;
  impact: DangerousImpact;
  compensation: { kind: 'undo' | 'restore' | 'noop'; description: string };
}

export async function previewDangerousImpact(input: {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  affectedCount?: number;
}): Promise<DangerousImpact> {
  const res = await axiosForBackend({
    url: '/api/operations/dangerous/impact',
    method: 'POST',
    data: input,
  });
  return res.data;
}

export async function confirmDangerous(input: {
  action: DangerousActionKind;
  targetType: string;
  targetId: string;
  affectedCount?: number;
  reason?: string;
  idempotencyKey?: string;
}): Promise<DangerousConfirmResult> {
  const res = await axiosForBackend({
    url: '/api/operations/dangerous/confirm',
    method: 'POST',
    data: input,
  });
  return res.data;
}

export async function undoDangerous(
  actionId: string,
  body: { targetType: string; targetId: string; reason?: string },
): Promise<{ actionId: string; undo: boolean; targetType: string; targetId: string }> {
  const res = await axiosForBackend({
    url: `/api/operations/dangerous/${encodeURIComponent(actionId)}/undo`,
    method: 'POST',
    data: body,
  });
  return res.data;
}
