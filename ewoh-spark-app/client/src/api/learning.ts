import { axiosForBackend } from '../lib/http';

/**
 * 学习段 API 客户端（评估 → 提案 → 影子 → 人审 → 回滚 / 时长模型重训）。
 *
 * 设计边界（服务端强制，前端不得放宽或绕过）：
 *  - 激活阶梯（approve / reject / rollback）是**高危写路径**，仅
 *    `workshop_lead` / `global_admin` 可调用；这里只做 UI 提示，不做权限判定。
 *  - 影子评估的证据由服务端从库内事实源重建，**不接受请求体提供的事实**；
 *    因此本客户端不提供"传入事实"的入口。
 *  - 时长模型只能由**独立设备回执**训练；人工上报与模拟回执永远不计入
 *    可训练样本（见训练样本资格摘要）。
 */

export type LearningProposalStatus =
  | 'proposed' | 'shadow_evaluated' | 'approved' | 'rejected' | 'rolled_back';

export interface ThresholdChange {
  ruleId: string;
  parameter: string;
  baselineValue: number;
  candidateValue: number;
}

export interface ShadowEval {
  accepted?: boolean;
  reason?: string;
  metrics?: Record<string, unknown>;
  evaluatedAt?: string;
  [key: string]: unknown;
}

export interface LearningProposalRecord {
  proposalId: string;
  kind: string;
  status: LearningProposalStatus | string;
  change: ThresholdChange;
  shadowEval?: ShadowEval;
  evaluationRef?: { evalId: string };
  /**
   * 提议人（B5 同族审批独立性，standalone_073）。服务端记录；
   * 与其相同的身份不能批准本提案（服务端 403 SELF_APPROVAL_FORBIDDEN）。
   * 存量行可能缺失（NULL = 未回填），此时服务端放行。
   */
  proposedBy?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedReason?: string;
  rolledBackBy?: string;
  rolledBackReason?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/**
 * 阈值基线条目（GET /api/learning/thresholds）。
 *
 * 诚信要求：`source` 必须如实区分「已批准提案覆盖」与「引擎内置常量」——
 * 没有覆盖时 `effective` 是引擎常量，绝不能被展示成"已激活的策略"；
 * `engineDefault=null` + `source=engine_default_unknown` 表示该参数没有登记
 * 内置常量，UI 必须显示未知而不是猜一个数。
 */
export interface ThresholdBaselineEntry {
  ruleId: string;
  parameter: string;
  engineDefault: number | null;
  effective: number | null;
  source: 'approved_proposal' | 'engine_default' | 'engine_default_unknown' | string;
  provenance: {
    proposalId: string;
    baselineValue: number;
    candidateValue: number;
    approvedBy: string | null;
    approvedAt: string | null;
    proposedBy: string | null;
    shadowEval?: ShadowEval | null;
    shadowFactsProvenance?: Record<string, unknown> | null;
  } | null;
  counts: { pending: number; approved: number; rejected: number; rolledBack: number };
}

export interface ThresholdBaseline {
  readAt: string;
  engineVersion: string;
  entries: ThresholdBaselineEntry[];
}

export interface LearningEvaluationRecord {
  evalId: string;
  evaluationType?: string;
  periodStart?: string;
  periodEnd?: string;
  metrics?: Record<string, unknown>;
  /**
   * 模型准确率。缺 outcome 标注时为 `null`——这是**如实表达缺失**，
   * UI 必须显示"未标注"而不是 0 或"100%"。
   */
  modelAccuracy?: number | null;
  createdAt?: string;
  [key: string]: unknown;
}

/** 训练样本资格摘要（GET predictions/task-duration/samples）。 */
export interface TrainingSampleSummary {
  orgId: string;
  sampleLimit: number;
  totalFeedbackRows: number;
  /** 通过行级标记的行数（不等同于可训练数）。 */
  flaggedEligible: number;
  /** 训练实际可用样本数。 */
  trainable: number;
  minSamplesRequired: number;
  fullyTrained: boolean;
  rejected: Partial<Record<string, number>>;
  rejectedLabels: Record<string, string>;
  /** 资格策略标识：只有独立设备回执可训练生产模型。 */
  eligibilityPolicy: string;
}

export interface RetrainResult {
  ok: boolean;
  modelId: string;
  version: string | null;
  n?: number;
  medianMs?: number;
  p90Ms?: number;
  lineage?: {
    trainedFrom: string;
    eligibilityPolicy: string;
    trainableSamples: number | null;
    flaggedEligible: number | null;
    minSamplesRequired: number | null;
    perTaskType: Array<{ taskType: string; ok: boolean; version: string | null; notEnoughDataReason?: string }>;
  };
}

export async function listEvaluations(limit?: number): Promise<LearningEvaluationRecord[]> {
  const res = await axiosForBackend({
    url: '/api/learning/evaluations',
    method: 'GET',
    params: limit ? { limit } : undefined,
  });
  return normalizeList<LearningEvaluationRecord>(res.data, ['evaluations', 'data', 'items']);
}

export async function runEvaluation(body: {
  evaluationType?: 'periodic' | 'on_demand';
  periodStartMs?: number;
  periodEndMs?: number;
} = { evaluationType: 'on_demand' }): Promise<LearningEvaluationRecord> {
  const res = await axiosForBackend({ url: '/api/learning/evaluate', method: 'POST', data: body });
  return res.data as LearningEvaluationRecord;
}

export async function listProposals(filters: { kind?: string; status?: string } = {}): Promise<LearningProposalRecord[]> {
  const res = await axiosForBackend({
    url: '/api/learning/proposals',
    method: 'GET',
    params: {
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
  });
  return normalizeList<LearningProposalRecord>(res.data, ['proposals', 'data', 'items']);
}

/**
 * 当前阈值基线（只读）。
 *
 * 提议者必须先看到真实基线（生效值 + 来源 + 读取时间 + 在途提案计数）才能
 * 提出有意义的候选值——不读此面就只能猜基线（决策原则 5：影响面与来源必须可见）。
 */
export async function getThresholdBaseline(): Promise<ThresholdBaseline> {
  const res = await axiosForBackend({ url: '/api/learning/thresholds', method: 'GET' });
  return res.data as ThresholdBaseline;
}

/**
 * 提出受控变更（rule_threshold 提案）。
 *
 * 边界（服务端强制）：本调用**只是提案**，不激活任何东西；
 *  - 影子评估证据由服务端从库内事实源重建，故此处不传 facts；
 *  - 激活必经 workshop_lead / global_admin 人审，且提议人不得审批自己的提案；
 *  - 提议人身份取服务端会话（请求体不可伪造）。
 */
export async function createProposal(input: {
  ruleId: string;
  parameter: string;
  baselineValue: number;
  candidateValue: number;
}): Promise<{ proposal: LearningProposalRecord; created: boolean }> {
  const res = await axiosForBackend({
    url: '/api/learning/proposals',
    method: 'POST',
    data: {
      kind: 'rule_threshold',
      change: {
        ruleId: input.ruleId,
        parameter: input.parameter,
        baselineValue: input.baselineValue,
        candidateValue: input.candidateValue,
      },
    },
  });
  return res.data as { proposal: LearningProposalRecord; created: boolean };
}

/**
 * 影子评估：服务端从库内事实源重建证据，请求体不携带事实
 * （R2-SBZ-004：客户端 facts 仅作对账提示，不作证据——因此这里不传）。
 */
export async function shadowEvaluateProposal(proposalId: string): Promise<LearningProposalRecord> {
  const res = await axiosForBackend({
    url: `/api/learning/proposals/${encodeURIComponent(proposalId)}/shadow`,
    method: 'POST',
    data: {},
  });
  return res.data as LearningProposalRecord;
}

/** 人审激活（仅 workshop_lead / global_admin；服务端强制）。 */
export async function approveProposal(proposalId: string): Promise<LearningProposalRecord> {
  const res = await axiosForBackend({
    url: `/api/learning/proposals/${encodeURIComponent(proposalId)}/approve`,
    method: 'POST',
    data: {},
  });
  return res.data as LearningProposalRecord;
}

/** 人审拒绝（必须给出理由——拒绝理由会进审计）。 */
export async function rejectProposal(proposalId: string, reason: string): Promise<LearningProposalRecord> {
  const res = await axiosForBackend({
    url: `/api/learning/proposals/${encodeURIComponent(proposalId)}/reject`,
    method: 'POST',
    data: { reason },
  });
  return res.data as LearningProposalRecord;
}

/** 回滚已生效的阈值覆盖（仅 workshop_lead / global_admin；必须给出理由）。 */
export async function rollbackProposal(proposalId: string, reason: string): Promise<LearningProposalRecord> {
  const res = await axiosForBackend({
    url: `/api/learning/proposals/${encodeURIComponent(proposalId)}/rollback`,
    method: 'POST',
    data: { reason },
  });
  return res.data as LearningProposalRecord;
}

export async function getTrainingSamples(): Promise<TrainingSampleSummary> {
  const res = await axiosForBackend({
    url: '/api/scheduler/predictions/task-duration/samples',
    method: 'GET',
  });
  return res.data as TrainingSampleSummary;
}

/**
 * 结果标注（Outcome Annotation，ADR-034 真值标注面）。
 *
 * 这是学习回路"经验"一环的用户入口：对已终结的方案/决策/提案给出
 * 结构化结果判定（成功/部分成功/失败/无效 + 可选度量），供后续
 * 评估与模型训练引用。边界：
 *  - 判定人 judgedBy 由服务端会话推导（请求体传入会被忽略），前端不传；
 *  - targetType / outcomeKind 必须落在契约注册表内（服务端契约 fail-closed）；
 *  - measured 是可选的数值度量快照，缺省 = 不携带不猜测。
 */
export type OutcomeTargetType = 'plan' | 'decision' | 'proposal' | 'agent_command';
export type OutcomeKind = 'success' | 'partial_success' | 'failure' | 'invalid';

export interface OutcomeAnnotationRecord {
  annotationId: string;
  targetType: OutcomeTargetType | string;
  targetId: string;
  outcomeKind: OutcomeKind | string;
  judgedBy: string;
  judgedAt: string;
  measured?: Record<string, number>;
  comment?: string;
  auditTrail?: boolean;
}

export interface CreateOutcomeAnnotationInput {
  targetType: OutcomeTargetType;
  targetId: string;
  outcomeKind: OutcomeKind;
  measured?: Record<string, number>;
  comment?: string;
}

export async function createOutcomeAnnotation(
  input: CreateOutcomeAnnotationInput,
): Promise<{ annotation: OutcomeAnnotationRecord; created: boolean }> {
  const res = await axiosForBackend({
    url: '/api/learning/annotations',
    method: 'POST',
    data: input,
  });
  return res.data as { annotation: OutcomeAnnotationRecord; created: boolean };
}

export async function listRecentAnnotations(
  outcomeKind?: OutcomeKind,
  limit?: number,
): Promise<OutcomeAnnotationRecord[]> {
  const res = await axiosForBackend({
    url: '/api/learning/annotations/recent',
    method: 'GET',
    params: {
      ...(outcomeKind ? { outcomeKind } : {}),
      ...(limit ? { limit } : undefined),
    },
  });
  return normalizeList<OutcomeAnnotationRecord>(res.data, ['annotations', 'data', 'items']);
}

export async function listAnnotationsByTarget(
  targetType: OutcomeTargetType,
  targetId: string,
): Promise<OutcomeAnnotationRecord[]> {
  const res = await axiosForBackend({
    url: '/api/learning/annotations',
    method: 'GET',
    params: { targetType, targetId },
  });
  return normalizeList<OutcomeAnnotationRecord>(res.data, ['annotations', 'data', 'items']);
}

/**
 * 最新一次学习评估（GET /api/learning/latest）。
 * 本租户尚无评估记录时服务端返回 400 learning_evaluation_not_found——
 * 这是"还没有评估"的业务状态而非故障，此处归一化为 null，不当作异常上抛。
 */
export async function getLatestEvaluation(): Promise<LearningEvaluationRecord | null> {
  try {
    const res = await axiosForBackend({ url: '/api/learning/latest', method: 'GET' });
    const payload = res.data as LearningEvaluationRecord | null;
    return payload && typeof payload === 'object' && 'evalId' in payload ? payload : null;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 400 || status === 404) return null;
    throw error;
  }
}

export async function retrainTaskDurationModel(): Promise<RetrainResult> {
  const res = await axiosForBackend({
    url: '/api/scheduler/predictions/task-duration/retrain',
    method: 'POST',
    data: {},
  });
  return res.data as RetrainResult;
}

/** 兼容多种列表包装（裸数组 / {key: []}）；结构不符返回空数组，不猜测。 */
function normalizeList<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

/* ── NO-54a：运行记忆信号（学习回路接线）────────────────────────────────
 *
 * 信号 ≠ 提案：扫描只写信号台账；`promoteLearningSignal` 才会创建学习提案，
 * 并进既有的影子评估 → 人审激活阶梯（前端不得跳过任何一步）。
 * `candidateValue` 必须由人给出：平台只给方向与依据，不替现场决定目标值。
 */

export type LearningSignalKind =
  | 'notification_fatigue' | 'data_quality_backlog' | 'deviation_repeat';
export type LearningSignalStatus = 'open' | 'promoted' | 'dismissed';
export type LearningSignalSeverity = 'low' | 'medium' | 'high';
export type LearningSignalConfidence = 'low' | 'medium' | 'high';
export type LearningSignalDirection = 'raise' | 'lower' | 'investigate';

export interface LearningSignalEvidenceDto {
  type: string;
  id: string;
  at: string | null;
  detail?: Record<string, unknown>;
}

export interface LearningSignalActionableDto {
  ruleId: string;
  parameter: string;
  direction: LearningSignalDirection;
  baselineValue: number;
  baselineSource: string;
}

export interface LearningSignalDto {
  signalId: string;
  kind: LearningSignalKind;
  severity: LearningSignalSeverity;
  status: LearningSignalStatus;
  subjectKey: string;
  windowDays: number;
  sampleSize: number;
  confidence: LearningSignalConfidence | null;
  metrics: Record<string, unknown>;
  narrative: { hypothesis: string; expectedEffect: string; risk: string; missing: string[] };
  evidenceRefs: LearningSignalEvidenceDto[];
  actionable: LearningSignalActionableDto | null;
  notActionableReason: string | null;
  detectedAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decidedReason?: string | null;
  promotedProposalId?: string | null;
}

export interface LearningSignalScanResult {
  orgId: string;
  windowDays: number;
  generatedAt: string;
  derived: number;
  created: number;
  refreshed: number;
  decisionsPreserved: number;
  rejected: Array<{ signalId: string; errors: string[] }>;
  signals: LearningSignalDto[];
  memory: {
    notificationTruncated: boolean;
    notificationScanned: number;
    openQualityAlerts: number;
    pendingQualityReminders: number;
    deviationObjects: number;
  };
}

/** 扫描运行记忆（幂等；只写信号，不创建提案）。 */
export async function scanLearningSignals(windowDays?: number): Promise<LearningSignalScanResult> {
  const res = await axiosForBackend({
    url: '/api/learning/signals/scan',
    method: 'POST',
    data: windowDays ? { windowDays } : {},
  });
  return res.data as LearningSignalScanResult;
}

export async function listLearningSignals(
  filters: { kind?: string; status?: string; limit?: number } = {},
): Promise<LearningSignalDto[]> {
  const res = await axiosForBackend({ url: '/api/learning/signals', method: 'GET', params: filters });
  return normalizeList<LearningSignalDto>(res.data, ['signals', 'items']);
}

/** 人点"生成提案"：目标值由人给；服务端会校验基线漂移与信号状态。 */
export async function promoteLearningSignal(
  signalId: string,
  input: { candidateValue: number; note?: string },
): Promise<{ signal: LearningSignalDto; proposalId: string; created: boolean }> {
  const res = await axiosForBackend({
    url: `/api/learning/signals/${encodeURIComponent(signalId)}/promote`,
    method: 'POST',
    data: input,
  });
  return res.data as { signal: LearningSignalDto; proposalId: string; created: boolean };
}

/** 人点"忽略"：理由必填（服务端拒绝空理由）。 */
export async function dismissLearningSignal(
  signalId: string,
  reason: string,
): Promise<LearningSignalDto> {
  const res = await axiosForBackend({
    url: `/api/learning/signals/${encodeURIComponent(signalId)}/dismiss`,
    method: 'POST',
    data: { reason },
  });
  return res.data as LearningSignalDto;
}

/* ── NO-55a：改进行动项（复盘经验 → 有人负责的行动）────────────────────
 *
 * 与阈值提案并列：阈值提案改"可激活的参数"，行动项改"做法"。
 * 接受必须给负责人/期限/验收判据；完成必须给结果说明（服务端强制）。
 */

export type ImprovementActionKind =
  | 'process_change' | 'training' | 'tooling' | 'maintenance' | 'threshold_review';
export type ImprovementActionStatus = 'proposed' | 'accepted' | 'rejected' | 'completed' | 'dropped';
export type ImprovementPriority = 'low' | 'medium' | 'high';

export interface ImprovementActionDto {
  actionId: string;
  sourceType: 'retrospective_lesson' | 'retrospective_gap';
  sourceRef: string;
  /** 对象归属（NO-58a）：这条经验说的是哪台设备/哪个人/哪个工位；null = 未绑定 → 复发不可度量。 */
  subjectType?: 'device' | 'person' | 'station' | null;
  subjectId?: string | null;
  title: string;
  detail: string;
  kind: ImprovementActionKind;
  kindSource: 'suggested' | 'human';
  priority: ImprovementPriority;
  status: ImprovementActionStatus;
  evidenceRefs: Array<{ type: string; id: string; at: string | null; detail?: Record<string, unknown> }>;
  owner?: string | null;
  dueAt?: string | null;
  acceptanceCriteria?: string | null;
  acceptedBy?: string | null;
  acceptedAt?: string | null;
  completedBy?: string | null;
  completedAt?: string | null;
  outcomeNote?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decidedReason?: string | null;
  detectedAt: string;
}

export interface ImprovementScanResult {
  orgId: string;
  generatedAt: string;
  scannedRetrospectives: number;
  derived: number;
  created: number;
  refreshed: number;
  decisionsPreserved: number;
  rejected: Array<{ actionId: string; errors: string[] }>;
  actions: ImprovementActionDto[];
  memory: { publishedRetrospectives: number; lessons: number; gaps: number };
}

/** 扫描已发布复盘 → 派生/刷新行动项（只读复盘，幂等）。 */
export async function scanImprovementActions(): Promise<ImprovementScanResult> {
  const res = await axiosForBackend({ url: '/api/learning/actions/scan', method: 'POST', data: {} });
  return res.data as ImprovementScanResult;
}

export async function listImprovementActions(
  filters: { status?: string; priority?: string; owner?: string; limit?: number } = {},
): Promise<ImprovementActionDto[]> {
  const res = await axiosForBackend({ url: '/api/learning/actions', method: 'GET', params: filters });
  return normalizeList<ImprovementActionDto>(res.data, ['actions', 'items']);
}

export async function getOverdueImprovementActions(): Promise<ImprovementActionDto[]> {
  const res = await axiosForBackend({ url: '/api/learning/actions/overdue', method: 'GET' });
  return normalizeList<ImprovementActionDto>(res.data, ['actions', 'items']);
}

export async function acceptImprovementAction(
  actionId: string,
  input: { owner: string; dueAt: string; acceptanceCriteria: string; kind?: ImprovementActionKind },
): Promise<ImprovementActionDto> {
  const res = await axiosForBackend({
    url: `/api/learning/actions/${encodeURIComponent(actionId)}/accept`,
    method: 'POST',
    data: input,
  });
  return res.data as ImprovementActionDto;
}

export async function completeImprovementAction(
  actionId: string,
  outcomeNote: string,
): Promise<ImprovementActionDto> {
  const res = await axiosForBackend({
    url: `/api/learning/actions/${encodeURIComponent(actionId)}/complete`,
    method: 'POST',
    data: { outcomeNote },
  });
  return res.data as ImprovementActionDto;
}

export async function decideImprovementAction(
  actionId: string,
  decision: 'rejected' | 'dropped',
  reason: string,
): Promise<ImprovementActionDto> {
  const res = await axiosForBackend({
    url: `/api/learning/actions/${encodeURIComponent(actionId)}/decision`,
    method: 'POST',
    data: { decision, reason },
  });
  return res.data as ImprovementActionDto;
}

/** 复发度量结论（NO-58a）。注意 `conclusion` 里**没有**"这条改进有效"——只是计数事实。 */
export type ImprovementActionEffectConclusion =
  | 'no_subject'
  | 'not_completed'
  | 'insufficient_sample'
  | 'recurrence_dropped'
  | 'recurrence_persisted';

export interface ImprovementActionEffectDto {
  actionId: string;
  subjectType: 'device' | 'person' | 'station' | null;
  subjectId: string | null;
  status: ImprovementActionStatus;
  completedAt: string | null;
  windowDays: number;
  before: { from: string; to: string; deviations: number };
  after: { from: string; to: string; deviations: number };
  conclusion: ImprovementActionEffectConclusion;
  reason: string;
  notes: string[];
  generatedAt: string;
}

/** 复发度量：完成前后各一个窗口内该对象的偏差计数（只读，不产生事实）。 */
export async function getImprovementActionEffect(
  actionId: string,
  options: { windowDays?: number } = {},
): Promise<ImprovementActionEffectDto> {
  const res = await axiosForBackend({
    url: `/api/learning/actions/${encodeURIComponent(actionId)}/effect`,
    method: 'GET',
    params: options.windowDays ? { windowDays: options.windowDays } : undefined,
  });
  return res.data as ImprovementActionEffectDto;
}
