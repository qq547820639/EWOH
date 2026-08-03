import { axiosForBackend } from '../lib/http';

export interface ScaleTemplate {
  templateId: string;
  name: string;
  version: string;
  lifecycleStatus: string;
  compatibleCore: string | null;
  createdAt: string;
}

export interface ScaleProfile {
  profileId: string;
  factoryName: string;
  templateId: string;
  status: string;
  installedAt: string | null;
  createdAt: string;
}

export interface ScaleAsset {
  packageId: string;
  packageType: string;
  name: string;
  version: string;
  status: string;
  publishedAt: string | null;
}

export interface CompatibilityRow {
  packageId: string;
  packageType: string;
  name: string;
  version: string;
  compatible: boolean;
  range: string | null;
  reason: string;
}

export interface ScaleCompatibility {
  coreVersion: string;
  compatibleCount: number;
  incompatibleCount: number;
  assets: CompatibilityRow[];
}

export interface OnboardingStepResult {
  code: string;
  name: string;
  passed: boolean;
  detail?: string;
  durationMs: number;
}

export interface OnboardingRunResult {
  runId: string;
  overall: string;
  profileId: string;
  steps: OnboardingStepResult[];
}

export interface FactoryDifference {
  key: string;
  factoryName: string;
  category: string;
  value: unknown;
  status: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface SupportBundleResult {
  bundleId: string;
  generatedAt: string;
  factoryCount: number;
  includesSecrets: boolean;
}

export interface FleetStatusProfile {
  profileId: string;
  factoryName: string;
  status: string;
  upgradeRing: string;
}

export interface FleetStatus {
  factoryCount: number;
  templateCount: number;
  assetPackageCount: number;
  statusCounts: Record<string, number>;
  ringCounts: Record<string, number>;
  profiles: FleetStatusProfile[];
}

export interface FleetUpgradeResult {
  packageId: string;
  targetRing: string;
  updatedProfiles: number;
  skippedProfiles: number;
}

export interface FleetRollbackResult {
  targetRing: string;
  rolledBackProfiles: number;
  skippedProfiles: number;
}

export interface WorkflowStepDefinition {
  name: string;
  action: string;
}

export interface WorkflowExample {
  workflowId: string;
  version: string;
  start: string;
  steps: WorkflowStepDefinition[];
}

export interface WorkflowInstance {
  key: string;
  workflowId: string;
  entityId: string;
  currentStep: string;
  status: string;
  history: Array<{ step: string; action?: string; at: string; actor?: string }>;
  updatedBy: string | null;
  updatedAt: string;
}

export async function listScaleTemplates(): Promise<ScaleTemplate[]> {
  const res = await axiosForBackend({ url: '/api/scale/templates', method: 'GET' });
  return res.data;
}

export async function listScaleProfiles(): Promise<ScaleProfile[]> {
  const res = await axiosForBackend({ url: '/api/scale/profiles', method: 'GET' });
  return res.data;
}

export async function listScaleAssets(): Promise<ScaleAsset[]> {
  const res = await axiosForBackend({ url: '/api/scale/assets', method: 'GET' });
  return res.data;
}

export async function getScaleCompatibility(): Promise<ScaleCompatibility> {
  const res = await axiosForBackend({ url: '/api/scale/compatibility', method: 'GET' });
  return res.data;
}

export async function installScenarioPack(
  packageId: string,
): Promise<ScaleAsset> {
  const res = await axiosForBackend({
    url: `/api/scale/scenario-packs/${encodeURIComponent(packageId)}/install`,
    method: 'POST',
  });
  return res.data;
}

export async function uninstallScenarioPack(
  packageId: string,
): Promise<ScaleAsset> {
  const res = await axiosForBackend({
    url: `/api/scale/scenario-packs/${encodeURIComponent(packageId)}/uninstall`,
    method: 'POST',
  });
  return res.data;
}

export async function runScaleOnboarding(
  factoryName: string,
): Promise<OnboardingRunResult> {
  const res = await axiosForBackend({
    url: '/api/scale/onboarding/run',
    method: 'POST',
    data: { factoryName },
  });
  return res.data;
}

export async function listFactoryDifferences(): Promise<FactoryDifference[]> {
  const res = await axiosForBackend({ url: '/api/scale/differences', method: 'GET' });
  return res.data;
}

export async function registerFactoryDifference(body: {
  factoryName: string;
  key: string;
  category?: string;
  value?: unknown;
}): Promise<FactoryDifference> {
  const res = await axiosForBackend({
    url: '/api/scale/differences',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function resolveFactoryDifference(
  key: string,
): Promise<FactoryDifference> {
  const res = await axiosForBackend({
    url: `/api/scale/differences/${encodeURIComponent(key)}/resolve`,
    method: 'POST',
  });
  return res.data;
}

export async function generateSupportBundle(): Promise<SupportBundleResult> {
  const res = await axiosForBackend({
    url: '/api/scale/fleet/support-bundle',
    method: 'POST',
  });
  return res.data;
}

export async function getFleetStatus(): Promise<FleetStatus> {
  const res = await axiosForBackend({ url: '/api/scale/fleet/status', method: 'GET' });
  return res.data;
}

export async function fleetUpgrade(
  packageId: string,
  ring?: string,
): Promise<FleetUpgradeResult> {
  const res = await axiosForBackend({
    url: '/api/scale/fleet/upgrade',
    method: 'POST',
    data: ring ? { packageId, ring } : { packageId },
  });
  return res.data;
}

export async function fleetRollback(ring?: string): Promise<FleetRollbackResult> {
  const res = await axiosForBackend({
    url: '/api/scale/fleet/rollback',
    method: 'POST',
    data: ring ? { ring } : {},
  });
  return res.data;
}

export async function getWorkflowExample(): Promise<WorkflowExample> {
  const res = await axiosForBackend({ url: '/api/workflows/examples', method: 'GET' });
  return res.data;
}

export async function listWorkflowInstances(): Promise<WorkflowInstance[]> {
  const res = await axiosForBackend({ url: '/api/workflows/instances', method: 'GET' });
  return res.data;
}

export async function startWorkflowInstance(
  workflow: WorkflowExample,
  entityId: string,
): Promise<WorkflowInstance> {
  const res = await axiosForBackend({
    url: '/api/workflows/instances',
    method: 'POST',
    data: { workflow, entityId },
  });
  return res.data;
}

export async function advanceWorkflowInstance(
  key: string,
  roles: string[],
): Promise<WorkflowInstance> {
  const res = await axiosForBackend({
    url: `/api/workflows/instances/${encodeURIComponent(key)}/advance`,
    method: 'POST',
    data: { roles },
  });
  return res.data;
}
