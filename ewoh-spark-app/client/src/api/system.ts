import { axiosForBackend } from '../lib/http';
import type { components } from '../types/openapi';

// 契约来源：openapi/ewoh.yaml（npm run gen:openapi）。
// 类型形状由生成的 client/src/types/openapi.d.ts 提供，不再手写维护。
export type SystemConfigRecord = components['schemas']['SystemConfig'];

export type FeatureFlagEvaluationResult =
  components['schemas']['FeatureFlagEvaluation'];

export type FeatureFlagEvaluationContext =
  components['schemas']['FeatureFlagEvaluateRequest']['context'];

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
