import { axiosForBackend } from '../lib/http';
import type { DecisionRecord } from '@shared/decision';

/** ADR-065 检索端点响应（服务端四表聚合为唯一读事实源）。 */
export interface DecisionHistoryResponse {
  items: DecisionRecord[];
  total: number;
  skippedInvalid: number;
  sources: {
    plans: number;
    agentApprovals: number;
    learningProposals: number;
    policies: number;
  };
}

export interface DecisionHistoryQuery {
  kind?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** NO-13q / ADR-066：决策历史检索（只读；租户由后端 ctx 注入）。 */
export async function fetchDecisionHistory(
  params: DecisionHistoryQuery = {},
): Promise<DecisionHistoryResponse> {
  // CLI-719：显式字段映射构造查询参数（替代整体 as 断言），undefined 字段
  // 不会被序列化进 query。
  const query: Record<string, string> = {};
  if (params.kind !== undefined) query.kind = String(params.kind);
  if (params.status !== undefined) query.status = String(params.status);
  if (params.limit !== undefined) query.limit = String(params.limit);
  if (params.offset !== undefined) query.offset = String(params.offset);
  const res = await axiosForBackend({
    url: '/api/scheduler/decision-history',
    method: 'GET',
    params: query,
  });
  return res.data;
}
