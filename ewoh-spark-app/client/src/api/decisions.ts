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
  const res = await axiosForBackend({
    url: '/api/scheduler/decision-history',
    method: 'GET',
    params: { ...params } as Record<string, unknown>,
  });
  return res.data;
}
