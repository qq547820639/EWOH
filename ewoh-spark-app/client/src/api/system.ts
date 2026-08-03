import { axiosForBackend } from '../lib/http';

export interface SystemConfigRecord {
  id: string;
  configKey: string;
  configValue: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: string;
}

export interface FeatureFlagEvaluationResult {
  key: string;
  enabled: boolean;
  reason: string;
  variant: string;
  targetingApplied: boolean;
}

export interface FeatureFlagEvaluationContext {
  orgId?: string;
  factoryId?: string;
  upgradeRing?: string;
  roles?: string[];
}

export async function listSystemConfigs(): Promise<SystemConfigRecord[]> {
  const res = await axiosForBackend({ url: '/api/system/config', method: 'GET' });
  return res.data;
}

export async function evaluateFeatureFlags(
  keys: string[],
  context: FeatureFlagEvaluationContext = {},
): Promise<FeatureFlagEvaluationResult[]> {
  const res = await axiosForBackend({
    url: '/api/system/feature-flags/evaluate',
    method: 'POST',
    data: { keys, context },
  });
  return res.data;
}
