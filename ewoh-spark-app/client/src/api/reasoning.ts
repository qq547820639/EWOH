import { axiosForBackend } from '../lib/http';

/**
 * 推理/风险 API（NO-25a）。
 *
 * 两条路径刻意分开：
 *   · `getLiveFacts`    只读投影（不评估、不落账）——排障与 AI 解释的事实来源；
 *   · `evaluateLive`    真正跑确定性规则并把结论落 L4 台账（人工触发）。
 * 响应同时带 evidence（依据）与 skipped（未采用数据 + 原因），前端不自行编造判定。
 */
export interface LiveFactsResponse {
  facts: Array<{ subjectId: string; kind: string; values: Record<string, number | boolean>; evidenceIds: string[] }>;
  evidence: Array<{
    evidenceId: string;
    subjectId: string;
    capability: string;
    field: string;
    value: number;
    threshold: number;
    unit: string;
    observedAt: string;
    ageMs: number;
    dataQuality: 'FRESH' | 'STALE' | 'UNKNOWN';
    dataConfidence: number | null;
    sourceType: string | null;
  }>;
  skipped: Array<{ sensorId: string; subjectId: string | null; field: string; reason: string; detail: string }>;
  limits: { vibrationMmPerSec: number; freshnessMs: number; minDataConfidence: number };
  snapshotVersion: number;
  readingsConsidered: number;
  generatedAt: string;
}

export interface EvaluateLiveResponse extends LiveFactsResponse {
  trace: {
    traceId: string;
    engineVersion: string;
    conclusions: Array<{
      conclusionId?: string;
      ruleId: string;
      subjectId: string;
      severity: string;
      explanation?: string;
      evidenceIds?: string[];
      /** 感知门控（NO-58b）：`true` = 只能当提示（原因见 `advisoryReason`）；字段缺省 = 平台未评估。 */
      advisoryOnly?: boolean;
      advisoryReason?: string | null;
    }>;
  };
  inferenceIds: Array<{ conclusionId: string; inferenceId: string }>;
}

export async function getLiveFacts(): Promise<LiveFactsResponse> {
  const res = await axiosForBackend({ url: '/api/reasoning/live-facts', method: 'GET' });
  return res.data;
}

/** 前端消费形状：结论平铺出来，UI 不必知道 trace 的内部结构。 */
export async function evaluateLive(): Promise<
  LiveFactsResponse & {
    conclusions: EvaluateLiveResponse['trace']['conclusions'];
    inferenceIds: Array<{ conclusionId: string; inferenceId: string }>;
  }
> {
  const res = await axiosForBackend({ url: '/api/reasoning/evaluate-live', method: 'POST', data: {} });
  const data = res.data as EvaluateLiveResponse;
  return {
    ...data,
    conclusions: data?.trace?.conclusions ?? [],
    inferenceIds: data?.inferenceIds ?? [],
  };
}
