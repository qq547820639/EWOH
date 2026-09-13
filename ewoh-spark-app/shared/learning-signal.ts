/* 前后端共享契约 —— 运行记忆信号（Learning Signal，NO-54a，§10 Level 7 + §12 反馈腿）。
 *
 * 补的缺口（`docs/architecture/capability-alignment.md` §3 原 #2）：学习回路此前只有
 * "人手工提一个阈值提案"（`shared/learning-proposal.ts`），**运行记忆没有接线**——
 * 提醒治理指标（处置率/账龄/反复出现的来源）、数据质量积压、执行偏差复发这些
 * 已经落库的事实，从来不会变成"该不该调策略"的候选。
 *
 * 本文件是**纯函数**：输入"实测记忆快照"，输出"信号"（含证据引用、样本量、
 * 可信度、方向、风险）。三条硬边界，任何一条都不许绕过：
 *   1. **样本不足不下结论**：`sampleSize < SIGNAL_MIN_SAMPLE` → `confidence = null`，
 *      且 `actionable` 必须为 null（宁可不建议，也不假装确信，原则 7）；
 *   2. **不作数值决策**：信号只给"方向 + 依据 + 风险"，**具体目标值必须由人给**
 *      （平台不替现场决定阈值该调到 0.62 还是 0.58——那是拿数字装确定性）；
 *   3. **不可执行必须说明理由**：`actionable = null` 时 `notActionableReason` 必填，
 *      页面上要能读出"为什么这条只能提示、不能变成提案"。
 */

import type { NotificationGovernanceSummary } from './notification-metrics';
import { notificationKindLabel } from './notification-metrics';

export const LEARNING_SIGNAL_KINDS = [
  /** 提醒治理：某类提醒长期没人处置/积压（噪音 or 阈值过紧）。 */
  'notification_fatigue',
  /** 数据质量待核实积压（数据不可信面没人收口）。 */
  'data_quality_backlog',
  /** 执行偏差在同一对象上复发（同一根因反复出现）。 */
  'deviation_repeat',
] as const;
export type LearningSignalKind = (typeof LEARNING_SIGNAL_KINDS)[number];

export const LEARNING_SIGNAL_STATUSES = ['open', 'promoted', 'dismissed'] as const;
export type LearningSignalStatus = (typeof LEARNING_SIGNAL_STATUSES)[number];

/** 方向：raise=阈值可能过紧/要放宽；lower=阈值可能过松/要收紧；investigate=证据不足以给方向。 */
export const LEARNING_SIGNAL_DIRECTIONS = ['raise', 'lower', 'investigate'] as const;
export type LearningSignalDirection = (typeof LEARNING_SIGNAL_DIRECTIONS)[number];

export const LEARNING_SIGNAL_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type LearningSignalConfidence = (typeof LEARNING_SIGNAL_CONFIDENCES)[number];

export const LEARNING_SIGNAL_SEVERITIES = ['low', 'medium', 'high'] as const;
export type LearningSignalSeverity = (typeof LEARNING_SIGNAL_SEVERITIES)[number];

export const LEARNING_SIGNAL_VERSION = '1.0.0';

/** 低于该样本量：不给可信度、也不给可执行方向（原则 7）。 */
export const SIGNAL_MIN_SAMPLE = 5;
/** 提醒积压信号触发门槛：待处置条数与最老待处置时长（同时满足才算"积压"）。 */
export const NOTIFICATION_FATIGUE_MIN_PENDING = 3;
export const NOTIFICATION_FATIGUE_MIN_AGE_MS = 8 * 60 * 60 * 1000;
export const NOTIFICATION_FATIGUE_ESCALATE_AGE_MS = 24 * 60 * 60 * 1000;
/** 处置率低于该值 = 多数提醒没人了结 → 方向 raise（阈值可能过紧，产生了无人处理的噪音）。 */
export const NOTIFICATION_LOW_DISPOSITION_RATE = 0.5;
/** 数据质量积压门槛。 */
export const DATA_QUALITY_BACKLOG_MIN_OPEN = 5;
export const DATA_QUALITY_BACKLOG_MIN_PENDING = 3;
/** 同一对象同一偏差类型的复发门槛。 */
export const DEVIATION_REPEAT_MIN_COUNT = 3;

/**
 * 提醒类型 → 可以映射到哪个策略参数（封闭词表）。
 *
 * 只有**确实与负载/介入时机相关**的提醒类型才允许映射到 `workloadThreshold`；
 * 其余（如数据质量提醒）即使积压也不是阈值问题，必须 `actionable = null` 并写明理由。
 * 注意：这里给的是"方向"，**不是目标值**。
 */
export const SIGNAL_ACTIONABLE_NOTIFICATION_KINDS: Readonly<Record<string, string>> = {
  session_long_running: '连续佩戴过久提醒积压 → 负载判定时机（阈值）可能过紧',
  telemetry_inactive_suspect: '疑似未佩戴/离岗提醒积压 → 负载判定时机（阈值）可能过紧',
  andon: '安灯升级提醒长期没人接手 → 现场介入能力与负载阈值不匹配',
};

/** 唯一可提案的参数（与 `shared/learning-proposal.ts` 的 THRESHOLD_RULES 对齐）。 */
export const SIGNAL_ACTIONABLE_TARGET = { ruleId: 'rule:worker-overload', parameter: 'workloadThreshold' } as const;

/** 一条证据引用（喂给"来源/时间/影响面"展示，原则 5）。 */
export interface LearningSignalEvidence {
  type:
    | 'notification_kind'
    | 'notification_source'
    | 'quality_alert'
    | 'execution_deviation'
    | 'threshold_baseline';
  id: string;
  /** 该证据的时间；null = 时间未知（不许用扫描时刻冒充）。 */
  at: string | null;
  detail?: Record<string, unknown>;
}

export interface LearningSignalActionable {
  ruleId: string;
  parameter: string;
  direction: Exclude<LearningSignalDirection, 'investigate'>;
  /** 扫描时刻的生效阈值（promote 时服务端会重新读取并比对，漂移即拒绝）。 */
  baselineValue: number;
  baselineSource: string;
}

export interface LearningSignalNarrative {
  hypothesis: string;
  expectedEffect: string;
  risk: string;
  /** 缺什么数据导致结论受限（没有则空数组，不写"无"）。 */
  missing: string[];
}

export interface LearningSignalRecord {
  signalId: string;
  kind: LearningSignalKind;
  severity: LearningSignalSeverity;
  status: LearningSignalStatus;
  subjectKey: string;
  windowDays: number;
  sampleSize: number;
  confidence: LearningSignalConfidence | null;
  metrics: Record<string, unknown>;
  narrative: LearningSignalNarrative;
  evidenceRefs: LearningSignalEvidence[];
  actionable: LearningSignalActionable | null;
  /** actionable=null 时必须非空：为什么只能提示不能提案。 */
  notActionableReason: string | null;
  detectedAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decidedReason?: string | null;
  promotedProposalId?: string | null;
}

/** 确定性信号号：`SIG-<KIND>-<subject>-<window>d-<sev>`（重复扫描同窗口同严重度 → 同一行）。 */
export function learningSignalId(
  kind: LearningSignalKind,
  subjectKey: string,
  windowDays: number,
  severity: LearningSignalSeverity,
): string {
  const subject = String(subjectKey ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 80) || 'unknown';
  const days = Number.isFinite(windowDays) ? Math.max(1, Math.trunc(windowDays)) : 1;
  const sev = LEARNING_SIGNAL_SEVERITIES.includes(severity) ? severity : 'low';
  return `SIG-${kind.toUpperCase()}-${subject}-${days}d-${sev}`;
}

/** 派生（可执行）信号号 → 提案号是**另一个**事实（人不点"生成提案"就没有提案）。 */
export function proposalIdForSignal(signalId: string): string {
  return `LP-${String(signalId ?? '').replace(/^SIG-/, '')}`.slice(0, 180);
}

export function isActionableDirection(direction: string | null | undefined): boolean {
  return direction === 'raise' || direction === 'lower';
}

const KIND_SET: ReadonlySet<string> = new Set(LEARNING_SIGNAL_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(LEARNING_SIGNAL_STATUSES);
const SEVERITY_SET: ReadonlySet<string> = new Set(LEARNING_SIGNAL_SEVERITIES);
const CONFIDENCE_SET: ReadonlySet<string> = new Set(LEARNING_SIGNAL_CONFIDENCES);

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** 校验信号记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateLearningSignal(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['signalId', 'kind', 'severity', 'status', 'subjectKey', 'windowDays', 'sampleSize', 'metrics', 'narrative', 'evidenceRefs', 'detectedAt']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (!isNonEmptyString(r.signalId)) return ['bad_signal_id'];
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (!SEVERITY_SET.has(String(r.severity))) return ['unknown_severity'];
  if (!isNonEmptyString(r.subjectKey)) return ['bad_subject_key'];
  if (typeof r.windowDays !== 'number' || !Number.isInteger(r.windowDays) || r.windowDays < 1) {
    return ['bad_window_days'];
  }
  if (typeof r.sampleSize !== 'number' || !Number.isInteger(r.sampleSize) || r.sampleSize < 0) {
    return ['bad_sample_size'];
  }
  if (r.confidence !== null && !CONFIDENCE_SET.has(String(r.confidence))) return ['unknown_confidence'];
  // 原则 7：样本不足不许给可信度。
  if (r.confidence !== null && (r.sampleSize as number) < SIGNAL_MIN_SAMPLE) {
    return ['confidence_requires_min_sample'];
  }
  if (r.metrics == null || typeof r.metrics !== 'object' || Array.isArray(r.metrics)) {
    return ['bad_metrics'];
  }
  if (Object.keys(r.metrics as Record<string, unknown>).length === 0) return ['empty_metrics'];
  const narrative = r.narrative;
  if (narrative == null || typeof narrative !== 'object' || Array.isArray(narrative)) {
    return ['bad_narrative'];
  }
  const n = narrative as Record<string, unknown>;
  for (const field of ['hypothesis', 'expectedEffect', 'risk']) {
    if (!isNonEmptyString(n[field])) return [`missing_narrative:${field}`];
  }
  if (!Array.isArray(n.missing)) return ['bad_narrative_missing'];
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length === 0) return ['missing_evidence'];
  if (r.evidenceRefs.some((e) => !isNonEmptyString((e as { id?: unknown })?.id))) {
    return ['bad_evidence'];
  }
  if (!isNonEmptyString(r.detectedAt) || Number.isNaN(Date.parse(String(r.detectedAt)))) {
    return ['bad_detected_at'];
  }
  const actionable = r.actionable ?? null;
  if (actionable !== null) {
    if (typeof actionable !== 'object' || Array.isArray(actionable)) return ['bad_actionable'];
    const a = actionable as Record<string, unknown>;
    if (!isNonEmptyString(a.ruleId) || !isNonEmptyString(a.parameter)) return ['bad_actionable'];
    if (!isActionableDirection(a.direction as string)) return ['actionable_direction_must_be_raise_or_lower'];
    if (typeof a.baselineValue !== 'number' || Number.isNaN(a.baselineValue)) return ['bad_actionable'];
    if (a.baselineValue < 0 || a.baselineValue > 1) return ['bad_actionable'];
    if (!isNonEmptyString(a.baselineSource)) return ['bad_actionable'];
    if (r.confidence === null) return ['actionable_requires_confidence'];
    if (isNonEmptyString(r.notActionableReason)) return ['actionable_conflicts_with_reason'];
  } else if (!isNonEmptyString(r.notActionableReason)) {
    // 不可执行却不说明理由 = 页面读起来像"平台藏着结论"。
    return ['not_actionable_requires_reason'];
  }
  return [];
}

/* ── 纯规则：运行记忆 → 信号 ─────────────────────────────────────────────── */

export interface LearningMemoryThreshold {
  ruleId: string;
  parameter: string;
  effective: number | null;
  source: string;
}

export interface LearningMemoryDeviation {
  objectType: string;
  objectId: string;
  deviationType: string;
  count: number;
  lastAt: string | null;
  samplePlanIds?: string[];
}

export interface LearningMemoryInput {
  orgId: string;
  windowDays: number;
  detectedAt: string;
  /** 提醒治理快照（共享纯函数 `summarizeNotificationDisposition` 的产出，口径唯一）。 */
  notification: NotificationGovernanceSummary;
  thresholds: LearningMemoryThreshold[];
  quality: { openAlerts: number; pendingReminders: number };
  deviations: LearningMemoryDeviation[];
  /** 每个信号最多带几条证据引用（默认 5）。 */
  maxEvidence?: number;
}

function hours(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return Math.round((ms / 3_600_000) * 10) / 10;
}

function severityRank(severity: LearningSignalSeverity): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

function actionableTarget(
  input: LearningMemoryInput,
  direction: Exclude<LearningSignalDirection, 'investigate'>,
): { actionable: LearningSignalActionable | null; reason: string | null } {
  const entry = input.thresholds.find(
    (t) => t.ruleId === SIGNAL_ACTIONABLE_TARGET.ruleId && t.parameter === SIGNAL_ACTIONABLE_TARGET.parameter,
  );
  if (!entry) {
    return { actionable: null, reason: '没有登记可提案的参数（阈值基线表为空）：先登记策略参数再谈调整' };
  }
  if (entry.effective === null || entry.source === 'engine_default_unknown') {
    return {
      actionable: null,
      reason: `生效阈值未知（source=${entry.source}）：不拿未知值当基线，先确认当前生效值`,
    };
  }
  return {
    actionable: {
      ruleId: SIGNAL_ACTIONABLE_TARGET.ruleId,
      parameter: SIGNAL_ACTIONABLE_TARGET.parameter,
      direction,
      baselineValue: entry.effective,
      baselineSource: entry.source,
    },
    reason: null,
  };
}

/** 提醒积压 → 每个"最该关注的提醒类型"一条信号（最多 3 条）。 */
function deriveNotificationFatigue(input: LearningMemoryInput, maxEvidence: number): LearningSignalRecord[] {
  const groups = input.notification.byKind.filter(
    (g) => g.kind !== 'unknown' && g.kind !== 'other' && g.pending >= NOTIFICATION_FATIGUE_MIN_PENDING,
  );
  const aged = groups.filter((g) => (g.oldestPendingAgeMs ?? 0) >= NOTIFICATION_FATIGUE_MIN_AGE_MS);
  const worst = [...aged].sort((a, b) => (b.oldestPendingAgeMs ?? 0) - (a.oldestPendingAgeMs ?? 0)).slice(0, 3);
  const signals: LearningSignalRecord[] = [];
  for (const group of worst) {
    const oldestMs = group.oldestPendingAgeMs ?? 0;
    const severity: LearningSignalSeverity = oldestMs >= NOTIFICATION_FATIGUE_ESCALATE_AGE_MS ? 'high' : 'medium';
    const comparable = group.comparable;
    const confidence: LearningSignalConfidence | null = comparable >= SIGNAL_MIN_SAMPLE ? 'medium' : null;
    // 处置率 = 已了结条数 / 该类型总条数（不是 resolved/comparable：后者恒接近 1，
    // 会把"大部分提醒没人处置"读成"处置率很高"——2026-09-12 实测踩到过）。
    const dispositionRate =
      comparable >= SIGNAL_MIN_SAMPLE && group.total > 0 ? group.resolved / group.total : null;
    const mapped = SIGNAL_ACTIONABLE_NOTIFICATION_KINDS[group.kind] ?? null;
    const missing: string[] = [];
    if (dispositionRate === null) {
      missing.push(`该类型可比样本只有 ${comparable} 条（门槛 ${SIGNAL_MIN_SAMPLE}）→ 不给处置率与可信度`);
    }
    if (input.notification.truncated) {
      missing.push('提醒行数达到取数上限，本信号只覆盖已取到的部分（不是全体）');
    }
    let direction: LearningSignalDirection = 'investigate';
    if (confidence !== null && dispositionRate !== null) {
      direction = dispositionRate < NOTIFICATION_LOW_DISPOSITION_RATE ? 'raise' : 'lower';
    }
    let actionable: LearningSignalActionable | null = null;
    let notActionableReason: string | null = null;
    if (mapped === null) {
      notActionableReason = `提醒类型「${notificationKindLabel(group.kind)}」积压与可提案参数（${SIGNAL_ACTIONABLE_TARGET.parameter}）没有确定映射：只提示，不自动生成提案`;
    } else if (confidence === null || direction === 'investigate') {
      notActionableReason = `证据不足以给方向（样本 ${comparable} < ${SIGNAL_MIN_SAMPLE}）：保留提示，等人补足观测或人工判断`;
    } else {
      const resolved = actionableTarget(input, direction);
      actionable = resolved.actionable;
      notActionableReason = resolved.reason;
    }
    const baseline = actionable?.baselineValue ?? null;
    signals.push({
      signalId: learningSignalId('notification_fatigue', group.kind, input.windowDays, severity),
      kind: 'notification_fatigue',
      severity,
      status: 'open',
      subjectKey: group.kind,
      windowDays: input.windowDays,
      sampleSize: Math.max(group.pending, comparable),
      confidence,
      metrics: {
        windowDays: input.windowDays,
        kind: group.kind,
        kindLabel: notificationKindLabel(group.kind),
        pending: group.pending,
        read: group.read,
        resolved: group.resolved,
        failedDelivery: group.failedDelivery,
        comparable,
        notComparable: group.notComparable,
        dispositionRate,
        oldestPendingAgeHours: hours(group.oldestPendingAgeMs),
        medianTimeToResolveHours: hours(group.medianTimeToResolveMs),
        minPendingThreshold: NOTIFICATION_FATIGUE_MIN_PENDING,
        minAgeThresholdHours: hours(NOTIFICATION_FATIGUE_MIN_AGE_MS),
        minSample: SIGNAL_MIN_SAMPLE,
      },
      narrative: {
        hypothesis: mapped
          ? `${notificationKindLabel(group.kind)}：${group.pending} 条待处置、最老 ${hours(oldestMs)} 小时没人了结 → ${mapped}`
          : `${notificationKindLabel(group.kind)}：${group.pending} 条待处置、最老 ${hours(oldestMs)} 小时没人了结 → 现场提醒疲劳或处置责任不清`,
        expectedEffect:
          direction === 'raise'
            ? `若确认是阈值过紧：提高 ${SIGNAL_ACTIONABLE_TARGET.parameter} 可减少无人处理的提醒（方向：放宽），影响面由影子评估给出`
            : direction === 'lower'
              ? `若确认阈值过松：降低 ${SIGNAL_ACTIONABLE_TARGET.parameter} 可让介入更早（方向：收紧），影响面由影子评估给出`
              : '先查清"没人处置"的原因（人不清楚、责任不清、提醒没送到），再决定是否动阈值',
        risk:
          severity === 'high'
            ? '积压已超过 24 小时：可能存在真实未处置风险（不只是噪音），动阈值前必须先确认现场状态'
            : '放宽阈值会漏掉早期介入时机；收紧阈值会加剧提醒噪音——两个方向都有代价',
        missing,
      },
      evidenceRefs: [
        {
          type: 'notification_kind',
          id: group.kind,
          at: input.notification.generatedAt ?? null,
          detail: {
            pending: group.pending,
            oldestPendingAgeHours: hours(group.oldestPendingAgeMs),
            comparable,
          },
        },
        ...input.notification.topSources
          .filter((s) => s.kind === group.kind)
          .slice(0, Math.max(0, maxEvidence - 1))
          .map((s) => ({
            type: 'notification_source' as const,
            id: s.externalRef,
            at: null,
            detail: { total: s.total, pending: s.pending, resolved: s.resolved },
          })),
        ...(baseline === null
          ? []
          : [
              {
                type: 'threshold_baseline' as const,
                id: `${actionable!.ruleId}/${actionable!.parameter}`,
                at: null,
                detail: { effective: baseline, source: actionable!.baselineSource },
              },
            ]),
      ],
      actionable,
      notActionableReason,
      detectedAt: input.detectedAt,
    });
  }
  return signals;
}

/** 数据质量待核实积压 → 一条信号（**不可映射到阈值**：数据可信度不是负载问题）。 */
function deriveQualityBacklog(input: LearningMemoryInput, maxEvidence: number): LearningSignalRecord[] {
  const { openAlerts, pendingReminders } = input.quality;
  if (openAlerts < DATA_QUALITY_BACKLOG_MIN_OPEN || pendingReminders < DATA_QUALITY_BACKLOG_MIN_PENDING) {
    return [];
  }
  const severity: LearningSignalSeverity = openAlerts >= DATA_QUALITY_BACKLOG_MIN_OPEN * 4 ? 'high' : 'medium';
  const sampleSize = Math.max(openAlerts, pendingReminders);
  const confidence: LearningSignalConfidence | null = sampleSize >= 10 ? 'medium' : 'low';
  return [
    {
      signalId: learningSignalId('data_quality_backlog', 'quality-alerts', input.windowDays, severity),
      kind: 'data_quality_backlog',
      severity,
      status: 'open',
      subjectKey: 'quality-alerts',
      windowDays: input.windowDays,
      sampleSize,
      confidence,
      metrics: {
        windowDays: input.windowDays,
        openQualityAlerts: openAlerts,
        pendingQualityReminders: pendingReminders,
        minOpenThreshold: DATA_QUALITY_BACKLOG_MIN_OPEN,
        minPendingThreshold: DATA_QUALITY_BACKLOG_MIN_PENDING,
      },
      narrative: {
        hypothesis: `${openAlerts} 条数据质量告警未了结、其中 ${pendingReminders} 条"待核实"提醒仍挂着 → 数据不可信面没人收口，相关决策缺少可信输入`,
        expectedEffect: '由班组长在班次工作台按告警逐条核实（成本低、当天可清）；清完后相关预测与调度的输入可信度提升',
        risk: '若长期不核实：要么把不可信数据当事实用（原则 7 红线），要么因"数据不可信"而冻结决策',
        missing: [],
      },
      evidenceRefs: [
        {
          type: 'quality_alert' as const,
          id: 'open-data-quality-alerts',
          at: null,
          detail: { open: openAlerts, pendingReminders },
        },
      ],
      actionable: null,
      notActionableReason:
        '数据质量积压属于"谁来核实"的运营问题，不是策略阈值问题：只能提示 + 进班次工作台处置，不生成阈值提案',
      detectedAt: input.detectedAt,
    },
  ];
}

/** 执行偏差复发 → 每个复发对象一条信号（按次数取前 3）。 */
function deriveDeviationRepeat(input: LearningMemoryInput, maxEvidence: number): LearningSignalRecord[] {
  const repeated = input.deviations
    .filter((d) => d.count >= DEVIATION_REPEAT_MIN_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return repeated.map((d) => {
    const severity: LearningSignalSeverity = d.count >= DEVIATION_REPEAT_MIN_COUNT + 2 ? 'high' : 'medium';
    return {
      signalId: learningSignalId(
        'deviation_repeat',
        `${d.objectType}:${d.objectId}:${d.deviationType}`,
        input.windowDays,
        severity,
      ),
      kind: 'deviation_repeat' as const,
      severity,
      status: 'open' as const,
      subjectKey: `${d.objectType}:${d.objectId}`,
      windowDays: input.windowDays,
      sampleSize: d.count,
      // 样本不足（复发次数 < 5）不给可信度：与 notification_fatigue 同一纪律（原则 7）。
      confidence: (d.count >= SIGNAL_MIN_SAMPLE ? 'medium' : null) as LearningSignalConfidence | null,
      metrics: {
        windowDays: input.windowDays,
        objectType: d.objectType,
        objectId: d.objectId,
        deviationType: d.deviationType,
        count: d.count,
        lastAt: d.lastAt,
        minCountThreshold: DEVIATION_REPEAT_MIN_COUNT,
      },
      narrative: {
        hypothesis: `${d.objectType} ${d.objectId} 在 ${input.windowDays} 天内出现 ${d.count} 次「${d.deviationType}」偏差 → 大概率是同一根因反复发生（而非偶发）`,
        expectedEffect: '先定位根因（工艺/设备/派工约束），再决定是改约束还是改策略参数；改参数前应有影子评估证据',
        risk: '把复发当偶发会导致"每次都重排、每次都偏"；直接把偏差归因到参数则可能掩盖真实设备问题',
        missing:
          d.count >= SIGNAL_MIN_SAMPLE
            ? []
            : [`复发次数 ${d.count} 少于可信度门槛 ${SIGNAL_MIN_SAMPLE}：只作提示，不给可信度`],
      },
      evidenceRefs: [
        {
          type: 'execution_deviation' as const,
          id: `${d.objectType}:${d.objectId}:${d.deviationType}`,
          at: d.lastAt,
          detail: { count: d.count, samplePlanIds: (d.samplePlanIds ?? []).slice(0, maxEvidence) },
        },
      ],
      actionable: null,
      notActionableReason:
        '偏差复发需要人先定根因（设备/工艺/派工），平台不把"偏差次数"直接换算成阈值调整',
      detectedAt: input.detectedAt,
    };
  });
}

/** 运行记忆 → 信号（确定性；同一输入必得同一批信号号）。 */
export function deriveLearningSignals(input: LearningMemoryInput): LearningSignalRecord[] {
  const maxEvidence = Number.isFinite(input.maxEvidence) ? Math.max(1, Number(input.maxEvidence)) : 5;
  const signals = [
    ...deriveNotificationFatigue(input, maxEvidence),
    ...deriveQualityBacklog(input, maxEvidence),
    ...deriveDeviationRepeat(input, maxEvidence),
  ];
  // 输出顺序稳定（严重度 desc → 信号号 asc），便于页面与测试断言。
  return signals.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    return bySeverity !== 0 ? bySeverity : a.signalId.localeCompare(b.signalId);
  });
}
