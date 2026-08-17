import { axiosForBackend } from './http';

/**
 * UX-005 Mapping Dry Run —— 调用后端现有接口：
 *   POST /api/scale/mappings/:id/dry-run  body: { sample }
 * 见 server/modules/scale/scale.service.ts dryRunMapping。
 *
 * 该接口要求 mappingId 已注册；若本地映射尚未注册或后端报错，调用方应展示
 * 错误并回退到本地示例 Dry Run（见 siteReadinessMapping.ts，标注"示例，非真实映射"）。
 *
 * TODO(后端)：待后端/现场接入，当前未启用。若希望向导内的本地映射直接 dry-run，
 * 后端需提供按规则集执行的 dry-run 接口（当前仅支持按已注册 mappingId 执行）。
 */

export interface BackendDryRunSample {
  sample: Record<string, unknown>;
}

/** dry-run 响应的宽松形状（后端契约未冻结，允许额外字段）。 */
export interface BackendDryRunResponse {
  result?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * CLI-547：导出响应形状并支持泛型收窄——原先返回 unknown 迫使每个调用方
 * 自行断言；默认按 BackendDryRunResponse 解析，调用方可传 T 覆盖。
 */
export async function runBackendMappingDryRun<T = BackendDryRunResponse>(
  mappingId: string,
  sample: Record<string, unknown>,
): Promise<T> {
  const res = await axiosForBackend<T>({
    url: `/api/scale/mappings/${encodeURIComponent(mappingId)}/dry-run`,
    method: 'POST',
    data: { sample } satisfies BackendDryRunSample,
  });
  return res.data;
}