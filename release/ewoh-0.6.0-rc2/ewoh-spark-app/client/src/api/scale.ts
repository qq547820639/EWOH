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
