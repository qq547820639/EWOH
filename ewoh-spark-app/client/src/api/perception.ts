import { axiosForBackend } from '../lib/http';

/**
 * 多模态感知融合 API 客户端（NO-56a，§5 感知融合层）。
 *
 * 边界：融合结论**不是**控制指令——`strongAdviceAllowed=false` 时上游不得据此生成强建议；
 * 无可用源时服务端返回 unknown/insufficient，前端必须显示"证据不足"，不许显示成 0%。
 */

export type PerceptionAgreement = 'consistent' | 'partial' | 'conflict' | 'insufficient';
export type PerceptionConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export interface PerceptionFusionDto {
  subjectId: string;
  windowStart: string;
  windowEnd: string;
  fusedAt: string;
  agreement: PerceptionAgreement;
  position: { x: number | null; y: number | null; z: number | null; stationId: string | null; basis: string[] } | null;
  posture: { pitchDeg: number | null; action: string | null; basis: string[] } | null;
  station: { stationId: string | null; basis: string; sources: string[] } | null;
  confidence: {
    level: PerceptionConfidenceLevel;
    score: number | null;
    basis: string;
    usableSources: string[];
    degraded: boolean;
    missingSources: string[];
    excludedSources: Array<{ source: string; sourceId: string; dimension: string; status: string; reason: string }>;
    unknownConfidenceSources: string[];
  };
  conflicts: Array<{
    dimension: string;
    severity: 'low' | 'medium' | 'high';
    participants: Array<{ source: string; sourceId: string; value: string }>;
    detail: string;
  }>;
  ruleTrace: Array<{ rule: string; fired: boolean; detail: string }>;
  strongAdviceAllowed: boolean;
  notes: string[];
}

export interface PerceptionSweepResult {
  orgId: string;
  windowStart: string;
  windowEnd: string;
  windowMinutes: number;
  bucketMinutes: number;
  subjects: number;
  persisted: number;
  created: number;
  refreshed: number;
  byAgreement: Record<string, number>;
  byConfidenceLevel: Record<string, number>;
  conflictSubjects: string[];
  degradedSubjects: string[];
  unmatchedVisionDetections: number;
  stationUnresolved: number;
  rejected: Array<{ subjectId: string; errors: string[] }>;
  notes: string[];
  fused: PerceptionFusionDto[];
}

/** 多源融合一次（幂等；只读感知事实）。 */
export async function sweepPerceptionFusion(
  input: { windowMinutes?: number; bucketMinutes?: number } = {},
): Promise<PerceptionSweepResult> {
  const res = await axiosForBackend({
    url: '/api/perception/fusion/sweep',
    method: 'POST',
    data: input,
  });
  return res.data as PerceptionSweepResult;
}

/** 最新融合快照（默认每个主体取最新）。 */
export async function listPerceptionFusion(
  filters: { subjectId?: string; agreement?: string; limit?: number } = {},
): Promise<PerceptionFusionDto[]> {
  const res = await axiosForBackend({ url: '/api/perception/fusion', method: 'GET', params: filters });
  return Array.isArray(res.data) ? (res.data as PerceptionFusionDto[]) : [];
}
