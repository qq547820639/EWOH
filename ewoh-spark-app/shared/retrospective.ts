/* 前后端共享契约 - 复盘/运行记忆（standalone_075，DR-3）。
 *
 * 权威契约：db/migrations/standalone_075_retrospective.sql +
 * contracts/events/event-catalog.yaml（RetrospectiveRecorded）。
 *
 * 语义：闭环六段（感知/数据质量/决策/授权/执行/反馈）的**组装产物**——
 * 每段只引用既有台账证据（evidenceIds 指向事件/方案/执行/标注等真实行），
 * 不是第二事实源；缺失环节显式进 gaps，不允许静默省略（原则 7）。
 * narrative 为 AI 总结，narrativeSource 双路留痕（llm | rule_fallback）。
 */

export const RETROSPECTIVE_SCOPES = ['plan', 'incident', 'shift'] as const;
export type RetrospectiveScope = (typeof RETROSPECTIVE_SCOPES)[number];

export const RETROSPECTIVE_STATUSES = ['draft', 'published', 'superseded'] as const;
export type RetrospectiveStatus = (typeof RETROSPECTIVE_STATUSES)[number];

export type NarrativeSource = 'llm' | 'rule_fallback';

export type LessonSeverity = 'info' | 'warning' | 'critical';

/** 结构化经验条目：AI 总结建议 + 人工修订后落账（工厂自己的运行记忆）。 */
export interface RetrospectiveLesson {
  title: string;
  detail: string;
  severity: LessonSeverity;
  evidenceIds: string[];
}

/** 第①段 感知：异常如何被发现（触发事件 + 时间 + 来源）。 */
export interface RetrospectivePerception {
  summary: string;
  triggerEventId: string | null;
  detectedAt: string | null;
  source: string | null;
  evidenceIds: string[];
}

/** 第②段 数据质量：自动分级 + 人工确认/质疑（闭环第②步的落点）。 */
export interface RetrospectiveDataQuality {
  level: string | null;
  confirmation: {
    verdict: 'confirmed' | 'contested';
    confirmedBy: string;
    confirmedAt: string;
    note?: string | null;
  } | null;
  freshnessNote: string | null;
  evidenceIds: string[];
}

/** 第③段 影响与决策：受影响对象 + 候选方案对比 + 约束/风险/可信度。 */
export interface RetrospectiveDecision {
  affectedTaskIds: string[];
  affectedPersonIds: string[];
  affectedDeviceIds: string[];
  affectedStationIds: string[];
  chosenPlanId: string | null;
  alternativePlanIds: string[];
  objectivesSummary: string;
  constraintsConsidered: string[];
  risks: string[];
  /** 可信度分级（不伪造数值置信度；unknown=证据不足）。 */
  confidence: { level: 'high' | 'medium' | 'low' | 'unknown'; basis: string };
  evidenceIds: string[];
}

/** 第④段 授权：人工审批或策略授权（谁在何时基于什么授权了执行）。 */
export interface RetrospectiveAuthorization {
  mode: 'human_approval' | 'auto_policy' | 'unknown';
  approvedBy: string | null;
  approvedAt: string | null;
  policyVersion: string | null;
  evidenceIds: string[];
}

/** 第⑤段 执行：派工与回执事实 + 偏差明细。 */
export interface RetrospectiveExecution {
  dispatchedAssignmentCount: number;
  receiptSummary: {
    completed: number;
    failed: number;
    inProgress: number;
    cancelled: number;
    unknown: number;
  };
  deviations: Array<{
    assignmentId: string;
    taskId: string | null;
    kind: string;
    planned: string | null;
    actual: string | null;
    detail: string | null;
  }>;
  evidenceIds: string[];
}

/** 第⑥段 反馈与学习：预计 vs 实际 + KPI + 结果标注 + 经验条目。 */
export interface RetrospectiveFeedback {
  plannedVsActualSummary: string;
  kpi: Record<string, number | null>;
  outcomeAnnotationIds: string[];
  lessons: RetrospectiveLesson[];
  evidenceIds: string[];
}

/** 六段组装 + 显式缺口清单（哪些环节没有数据，必须让读者看见）。 */
export interface AssembledRetrospective {
  perception: RetrospectivePerception;
  dataQuality: RetrospectiveDataQuality;
  decision: RetrospectiveDecision;
  authorization: RetrospectiveAuthorization;
  execution: RetrospectiveExecution;
  feedback: RetrospectiveFeedback;
  gaps: string[];
}

export interface RetrospectiveRecord {
  retrospectiveId: string;
  scope: RetrospectiveScope;
  targetId: string;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  triggerEventId: string | null;
  status: RetrospectiveStatus;
  assembled: AssembledRetrospective;
  narrative: string | null;
  narrativeSource: NarrativeSource | null;
  narrativeModel: string | null;
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

const SCOPE_SET: ReadonlySet<string> = new Set(RETROSPECTIVE_SCOPES);
const STATUS_SET: ReadonlySet<string> = new Set(RETROSPECTIVE_STATUSES);

/** 校验六段组装结构完整性；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateAssembledRetrospective(assembled: unknown): string[] {
  if (assembled == null || typeof assembled !== 'object' || Array.isArray(assembled)) {
    return ['assembled_must_be_object'];
  }
  const a = assembled as Record<string, unknown>;
  const segments = [
    'perception', 'dataQuality', 'decision', 'authorization', 'execution', 'feedback', 'gaps',
  ] as const;
  for (const seg of segments) {
    if (!(seg in a)) return [`missing_segment:${seg}`];
  }
  if (!Array.isArray(a.gaps)) return ['gaps_must_be_array'];
  return [];
}

/** 校验复盘记录（组装结构 + 顶层字段）；返回错误码列表（空 = 合法）。 */
export function validateRetrospectiveRecord(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  if (typeof r.retrospectiveId !== 'string' || r.retrospectiveId.trim() === '') {
    return ['bad_retrospective_id'];
  }
  if (!SCOPE_SET.has(String(r.scope))) return ['unknown_scope'];
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (typeof r.targetId !== 'string' || r.targetId.trim() === '') return ['bad_target_id'];
  if (typeof r.title !== 'string' || r.title.trim() === '') return ['bad_title'];
  const assembledErrors = validateAssembledRetrospective(r.assembled);
  if (assembledErrors.length > 0) return assembledErrors;
  if (
    r.narrativeSource !== undefined
    && r.narrativeSource !== null
    && r.narrativeSource !== 'llm'
    && r.narrativeSource !== 'rule_fallback'
  ) {
    return ['unknown_narrative_source'];
  }
  return [];
}
