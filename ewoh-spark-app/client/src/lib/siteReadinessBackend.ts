import { axiosForBackend } from './http';

/**
 * UX-005 Mapping Dry Run —— 调用后端现有接口：
 *   POST /api/scale/mappings/:id/dry-run  body: { sample }
 * 见 server/modules/scale/scale.service.ts dryRunMapping。
 *
 * 该接口要求 mappingId 已注册；若本地映射尚未注册或后端报错，调用方应展示
 * 错误并回退到本地示例 Dry Run（见 siteReadinessMapping.ts，标注"示例，非真实映射"）。
 *
 * TODO(后端): 若希望向导内的本地映射直接 dry-run，后端需提供按规则集执行的
 * dry-run 接口（当前仅支持按已注册 mappingId 执行）。
 */

export interface BackendDryRunSample {
  sample: Record<string, unknown>;
}

export async function runBackendMappingDryRun(
  mappingId: string,
  sample: Record<string, unknown>,
): Promise<unknown> {
  const res = await axiosForBackend({
    url: `/api/scale/mappings/${encodeURIComponent(mappingId)}/dry-run`,
    method: 'POST',
    data: { sample } satisfies BackendDryRunSample,
  });
  return res.data;
}