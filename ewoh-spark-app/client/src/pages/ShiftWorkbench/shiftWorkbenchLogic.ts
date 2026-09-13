import type { EventInfo } from '@shared/api.interface';
import type { ResponsibilityCoverageSnapshot } from '@client/src/api/deviceResponsibility';
import type { SchedulingPlanV2 } from '@shared/scheduler';
import type { ShiftDefinition, ShiftHandover } from '@shared/shift';
import type { ExecutionListResponse } from '@shared/api.interface';
import type { WorldSnapshotMaterial } from '@shared/scheduler';
import { classifyNotificationKind } from '@shared/notification-metrics';

/**
 * 班次工作台纯逻辑（DR-2，2026-09-11）。可测：所有展示口径在这里收敛，
 * 页面只做装配。原则：无数据显式未知（'—'），不伪造默认值。
 */

export interface ShiftWindowDisplay {
  label: string;
  detail: string;
  tone: 'current' | 'gap';
}

/** 当前班次横幅：有班次 → 名称+窗口；无匹配 → 显式"不在任何班次窗口"（不猜默认班）。 */
export function shiftBanner(
  current: ShiftDefinition | null | undefined,
  next: ShiftDefinition | null | undefined,
  loading: boolean,
  /**
   * FE-1：班次查询**读失败**（403/500）时置真。
   * 不传时旧行为不变；传真时绝不落回"当前不在任何班次窗口内"——
   * 那句文案会让人去重新登记班次定义，而真相往往是"没读到"。
   */
  unavailable = false,
): ShiftWindowDisplay {
  if (loading) {
    return { label: '班次解析中…', detail: '正在读取班次定义', tone: 'gap' };
  }
  if (unavailable) {
    return {
      label: '班次信息读取失败',
      detail: '无法判断当前班次（不代表当前不在班次窗口内）：请刷新重试，或联系管理员排查班次服务',
      tone: 'gap',
    };
  }
  if (!current) {
    return {
      label: '当前不在任何班次窗口内',
      detail: next ? `下一班：${next.name}（${next.startTime} 开始）` : '无有效班次定义（请联系管理员登记）',
      tone: 'gap',
    };
  }
  const tail = current.crossesMidnight ? '跨零点' : '';
  return {
    label: `当班：${current.name}`,
    detail: `窗口 ${current.startTime}–${current.endTime}${tail ? `（${tail}）` : ''}${
      next ? ` · 下一班 ${next.name}（${next.startTime}）` : ''
    }`,
    tone: 'current',
  };
}

export interface ShiftKpi {
  key: 'openAlerts' | 'pendingPlans' | 'executingPlans' | 'deviations' | 'materialShortage';
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'warning' | 'critical' | 'positive';
}

/** KPI 行：当班异常 / 待审批方案 / 执行中方案 / 执行偏差 / 物料缺口。 */
export function buildShiftKpis(input: {
  events?: EventInfo[];
  plans?: SchedulingPlanV2[];
  executions?: ExecutionListResponse;
  materials?: WorldSnapshotMaterial[];
  /**
   * FE-1：方案 / 执行记录**读失败**时置真。
   * 读失败会让数组退化为 `[]`，于是 KPI 显示 0 并配"无积压/暂无偏差记录"——
   * 把"没读到"说成"没有"。置真后数字显示 `—` 并明说读取失败（0 是有依据的结论，— 才是未知）。
   */
  plansUnavailable?: boolean;
  executionsUnavailable?: boolean;
  /**
   * FE-1（2026-09-13 对抗自查补口）：与 plans/executions 同理的另外两个读失败面。
   * events 读失败时 KPI 会渲染"当班未处置异常 0 + positive"——同屏的列表区明明写着
   * "异常事件读取失败"，KPI 却断言"没有异常"；materials（来自 dashboard/overview，
   * workshop_lead 打开本页即 403，而这正是班组长的默认落地页）读失败时旧文案
   * "无缺口行（未接入 ERP 时为空）"把读失败洗成"没接 ERP"。
   */
  eventsUnavailable?: boolean;
  materialsUnavailable?: boolean;
}): ShiftKpi[] {
  const openAlerts = (input.events ?? []).filter((e) => e.status === 'open');
  const critical = openAlerts.filter((e) => String(e.severity ?? '').toUpperCase() === 'L3').length;
  const pendingPlans = (input.plans ?? []).filter((p) => p.status === 'draft');
  const executingPlans = (input.plans ?? []).filter(
    (p) => p.status === 'dispatched' || p.status === 'executing',
  );
  const deviations = (input.executions?.executions ?? []).filter((e) => e.deviationType).length;
  const shortage = (input.materials ?? []).length;
  return [
    {
      key: 'openAlerts',
      label: '当班未处置异常',
      value: input.eventsUnavailable ? '—' : String(openAlerts.length),
      detail: input.eventsUnavailable
        ? '异常事件读取失败：数字不可用（不代表没有异常）'
        : critical > 0
          ? `含 L3 ${critical} 条（优先处置）`
          : '近 24h open 事件',
      tone: input.eventsUnavailable
        ? 'warning'
        : critical > 0
          ? 'critical'
          : openAlerts.length > 0
            ? 'warning'
            : 'positive',
    },
    {
      key: 'pendingPlans',
      label: '待审批方案',
      value: input.plansUnavailable ? '—' : String(pendingPlans.length),
      detail: input.plansUnavailable
        ? '方案数据读取失败：数字不可用（不代表没有积压）'
        : pendingPlans.length > 0
          ? '方案等待会签，可能阻塞派工'
          : '无积压',
      tone: input.plansUnavailable ? 'warning' : pendingPlans.length > 0 ? 'warning' : 'positive',
    },
    {
      key: 'executingPlans',
      label: '执行中方案',
      value: input.plansUnavailable ? '—' : String(executingPlans.length),
      detail: input.plansUnavailable
        ? '方案数据读取失败：数字不可用（不代表没有执行中方案）'
        : '已下发/执行中（含部分派工）',
      tone: input.plansUnavailable ? 'warning' : 'neutral',
    },
    {
      key: 'deviations',
      label: '执行偏差',
      value: input.executionsUnavailable ? '—' : String(deviations),
      detail: input.executionsUnavailable
        ? '执行记录读取失败：偏差数字不可用（不代表没有偏差）'
        : deviations > 0
          ? '有偏差的执行记录（计划 vs 实际）'
          : '暂无偏差记录',
      tone: input.executionsUnavailable ? 'warning' : deviations > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'materialShortage',
      label: '物料缺口',
      value: input.materialsUnavailable ? '—' : shortage > 0 ? String(shortage) : '—',
      detail: input.materialsUnavailable
        ? '物料数据读取失败：无法判断缺口（不代表没有缺口）'
        : shortage > 0
          ? '有缺口/低于阈值的物料（详见物料页）'
          : '无缺口行（未接入 ERP 时为空）',
      tone: input.materialsUnavailable ? 'warning' : shortage > 0 ? 'warning' : 'neutral',
    },
  ];
}

export interface AnomalyRow {
  eventId: string;
  title: string;
  severity: string;
  occurredAt: string | null;
  sourceType: string | null;
  dqVerdict: 'confirmed' | 'contested' | null;
}

/** 当班异常行（附数据质量确认状态——闭环第②步在前端的落点）。 */
export function buildAnomalyRows(
  events: EventInfo[] | undefined,
  confirmations: Array<{ eventId: string; verdict: 'confirmed' | 'contested' }>,
): AnomalyRow[] {
  const byEvent = new Map(confirmations.map((c) => [c.eventId, c.verdict]));
  return (events ?? [])
    .filter((e) => e.status === 'open')
    .slice(0, 10)
    .map((e) => ({
      eventId: e.eventId,
      title: e.title ?? e.eventType ?? e.eventId,
      severity: String(e.severity ?? 'L1'),
      occurredAt: e.createdAt ?? null,
      sourceType: e.sourceType ?? null,
      dqVerdict: byEvent.get(e.eventId) ?? null,
    }));
}

/** 交接班遗留事项摘要（结构化条目 → 一行可读文本）。 */
export function handoverSummary(handover: ShiftHandover): string {
  const open = handover.openItems ?? [];
  if (open.length === 0) return '无遗留事项';
  const critical = open.filter((i) => i.severity === 'critical').length;
  const warning = open.filter((i) => i.severity === 'warning').length;
  const parts: string[] = [`${open.length} 项遗留`];
  if (critical > 0) parts.push(`严重 ${critical}`);
  if (warning > 0) parts.push(`注意 ${warning}`);
  return parts.join(' · ');
}

/** 页面数据可信度输入（接线孤儿组件 DataCredibility）。 */
export function pageCredibility(input: {
  eventsUpdatedAt: number;
  plansUpdatedAt: number;
  now: number;
}): {
  sourceType: string;
  collectedAt: string;
  lastSyncedAt: string;
  completeness: number;
  confidence: number;
  isSimulatedOrReplay: boolean;
} {
  const latest = Math.max(input.eventsUpdatedAt, input.plansUpdatedAt);
  return {
    sourceType: 'real',
    collectedAt: new Date(latest > 0 ? latest : input.now).toISOString(),
    lastSyncedAt: new Date(latest > 0 ? latest : input.now).toISOString(),
    completeness: latest > 0 ? 1 : 0,
    confidence: latest > 0 ? 0.8 : 0,
    isSimulatedOrReplay: false,
  };
}

/* ── NO-52a：交接班前的责任人核对（展示口径）──────────────────────────── */

export interface ResponsibilityReadinessView {
  /** 口径行："按班次 SHIFT-X 核对：共 N 台登记了责任人的设备"。 */
  scopeLabel: string;
  /** 结论行："覆盖 N 台 · 本班缺口 M 台 · 未登记责任人 K 台"。 */
  summaryLabel: string;
  /** 班次未知时显式说明（不猜默认班）。 */
  shiftUnknownNote: string | null;
  /** 缺口设备（交接时先看这些）。 */
  gapRows: Array<{ deviceId: string; detail: string }>;
  /** 未登记责任人的设备数（更宽的缺口）。 */
  uncovered: number;
  notes: string[];
  /** 有没有需要交接时处理的事（缺口或未登记）。 */
  needsAttention: boolean;
}

/** 毫秒/无 → 与后端同一口径：空串班次 = 全天。 */
function shiftLabel(shiftId: string | null | undefined): string {
  const key = String(shiftId ?? '').trim();
  return key === '' ? '全天' : `班次 ${key}`;
}

export function buildResponsibilityReadinessView(
  snapshot: ResponsibilityCoverageSnapshot | null | undefined,
): ResponsibilityReadinessView {
  if (!snapshot) {
    return {
      scopeLabel: '尚未取到责任人核对数据',
      summaryLabel: '—',
      shiftUnknownNote: null,
      gapRows: [],
      uncovered: 0,
      notes: [],
      needsAttention: false,
    };
  }
  const gapRows = snapshot.devices
    .filter((device) => !device.covered)
    .map((device) => ({
      deviceId: device.deviceId,
      detail:
        device.outOfShift.length > 0
          ? `只有 ${device.outOfShift.map((o) => shiftLabel(o.shiftId)).join('、')} 的责任人（本班不在岗）`
          : '没有本班或全天责任人',
    }));
  return {
    scopeLabel:
      `按 ${snapshot.shiftUnknown ? '当前班次（未匹配到班次定义）' : shiftLabel(snapshot.shiftId)} 核对：`
      + `共 ${snapshot.total} 台设备登记了责任人`,
    summaryLabel:
      `本班覆盖 ${snapshot.covered} 台 · 本班缺口 ${snapshot.gaps} 台 · 未登记责任人 ${snapshot.uncovered} 台`,
    shiftUnknownNote: snapshot.shiftUnknown
      ? '当前班次未知：只能按"全天责任人"口径判定，班次责任人无法认定为本班（请先登记班次定义）'
      : null,
    gapRows,
    uncovered: snapshot.uncovered,
    notes: Array.isArray(snapshot.notes) ? snapshot.notes : [],
    needsAttention: snapshot.gaps > 0 || snapshot.uncovered > 0,
  };
}

/* ── NO-53a：数据质量"待核实提醒"是否真的叫到了人（展示口径）────────────── */

export interface QualityVerificationRow {
  /** 源告警事件号（判定回写用）；缺失时为 null —— 不许假装能确认。 */
  alertEventId: string | null;
  /** 同一告警的多条提醒（不同收件人/渠道）合并后的通知号。 */
  notificationIds: string[];
  title: string;
  body: string | null;
  severity: string;
  /** 被叫到的收件人（去重后，人 + 角色）。 */
  recipients: string[];
  channels: string[];
  pendingCount: number;
  /** 已读 ≠ 已处置：读过的条数单独给出。 */
  readCount: number;
  /** 投递失败条数（"以为叫到了，其实没送到"）。 */
  failedDeliveryCount: number;
  firstNotifiedAt: string | null;
  /** "叫了多久没人应"；时间未知时显式说明。 */
  waitingLabel: string;
}

export interface QualityVerificationView {
  rows: QualityVerificationRow[];
  /** 未处置提醒条数（含同一告警的多个收件人）。 */
  pendingNotificationCount: number;
  failedDeliveryCount: number;
  /** 被截断隐藏的行数。 */
  hiddenRows: number;
  notes: string[];
  needsAttention: boolean;
}

/** 等待时长（人话；未知不猜）。 */
function waitingLabel(createdAt: string | null, now: number): string {
  if (!createdAt) return '叫到时间未知';
  const ms = now - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '叫到时间未知（时钟异常）';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `已等待 ${hours} 小时`;
  return `已等待 ${Math.floor(hours / 24)} 天`;
}

/**
 * 数据质量待核实提醒 → 页面视图。
 *
 * 只看 kind='data_quality'（用共享分类器，不在页面里硬编码前缀）；同一源告警的多条
 * 收件人提醒合并为一行，"叫了多久/叫了谁/有没有送到"三个问题必须能答；
 * 投递失败与未关联源事件都显式写出，不允许渲染成"已经在处理了"。
 */
export function buildQualityVerificationView(
  notifications: Array<{
    notificationId: string;
    recipientType: string;
    recipientId: string;
    channel: string;
    title: string;
    body: string | null;
    severity: string;
    status: string;
    externalRef: string | null;
    createdAt: string | null;
    errorMessage: string | null;
    resolution?: string | null;
  }> | undefined,
  options: { now?: number; limit?: number } = {},
): QualityVerificationView {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 5;
  const pending = (notifications ?? []).filter(
    (n) => classifyNotificationKind(n.notificationId) === 'data_quality' && !n.resolution,
  );
  const groups = new Map<string, QualityVerificationRow>();
  let unlinked = 0;
  for (const n of pending) {
    const ref = String(n.externalRef ?? '').trim();
    if (ref === '') unlinked += 1;
    const key = ref === '' ? `unlinked:${n.notificationId}` : ref;
    const existing = groups.get(key);
    const failed = n.status === 'failed' || Boolean(n.errorMessage);
    if (!existing) {
      groups.set(key, {
        alertEventId: ref === '' ? null : ref,
        notificationIds: [n.notificationId],
        title: n.title,
        body: n.body,
        severity: n.severity,
        recipients: [`${n.recipientType}:${n.recipientId}`],
        channels: [n.channel],
        pendingCount: 1,
        readCount: n.status === 'read' ? 1 : 0,
        failedDeliveryCount: failed ? 1 : 0,
        firstNotifiedAt: n.createdAt,
        waitingLabel: waitingLabel(n.createdAt, now),
      });
      continue;
    }
    existing.notificationIds.push(n.notificationId);
    const recipient = `${n.recipientType}:${n.recipientId}`;
    if (!existing.recipients.includes(recipient)) existing.recipients.push(recipient);
    if (!existing.channels.includes(n.channel)) existing.channels.push(n.channel);
    existing.pendingCount += 1;
    if (n.status === 'read') existing.readCount += 1;
    if (failed) existing.failedDeliveryCount += 1;
    const current = existing.firstNotifiedAt ? new Date(existing.firstNotifiedAt).getTime() : null;
    const candidate = n.createdAt ? new Date(n.createdAt).getTime() : null;
    if (candidate !== null && (current === null || candidate < current)) {
      existing.firstNotifiedAt = n.createdAt;
    }
  }
  const all = [...groups.values()].map((row) => ({
    ...row,
    waitingLabel: waitingLabel(row.firstNotifiedAt, now),
  }));
  // 待处置最久优先；时间未知排最后（不因为缺时间就抢占置顶）。
  all.sort((a, b) => {
    const at = a.firstNotifiedAt ? new Date(a.firstNotifiedAt).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.firstNotifiedAt ? new Date(b.firstNotifiedAt).getTime() : Number.POSITIVE_INFINITY;
    return at - bt;
  });
  const rows = all.slice(0, Math.max(0, limit));
  const failedDeliveryCount = all.reduce((sum, row) => sum + row.failedDeliveryCount, 0);
  const notes: string[] = [];
  if (unlinked > 0) {
    notes.push(`有 ${unlinked} 条提醒没有关联源告警事件号：无法回写核实判定，需先排查提醒写入方`);
  }
  if (failedDeliveryCount > 0) {
    notes.push(`有 ${failedDeliveryCount} 条提醒投递失败：不能视为"已经叫到人"，需改用其它方式通知`);
  }
  if (all.length > rows.length) {
    notes.push(`另有 ${all.length - rows.length} 条待核实提醒未在此列出（页面只显示最久的 ${rows.length} 条）`);
  }
  return {
    rows,
    pendingNotificationCount: all.reduce((sum, row) => sum + row.pendingCount, 0),
    failedDeliveryCount,
    hiddenRows: Math.max(0, all.length - rows.length),
    notes,
    needsAttention: all.length > 0,
  };
}

/* ── NO-56a：多模态感知融合的展示口径（§5 融合层）──────────────────────── */

export interface PerceptionFusionView {
  subjectId: string;
  agreementLabel: string;
  agreementTone: 'neutral' | 'positive' | 'warning' | 'critical';
  stationLabel: string;
  postureLabel: string;
  /** 可信度文案：无可用源 → "证据不足（不给分）"，不显示 0%。 */
  confidenceLabel: string;
  confidenceKnown: boolean;
  degradedLabel: string | null;
  /** 冲突逐条（各源取值都列出来，不丢证据）。 */
  conflictLabels: string[];
  /** 参与融合的源 / 缺失源 / 被排除证据。 */
  sourceLabel: string;
  missingLabel: string | null;
  excludedLabels: string[];
  /** 规则 5：低置信度/有冲突时上游不得生成强建议。 */
  adviceLabel: string;
  notes: string[];
}

const AGREEMENT_LABELS: Record<string, string> = {
  consistent: '一致（UWB×视觉交叉验证）',
  partial: '部分一致（缺交叉验证或先验）',
  conflict: '冲突（各源不一致）',
  insufficient: '证据不足',
};

export function perceptionAgreementLabel(agreement: string | null | undefined): string {
  const key = String(agreement ?? '');
  return AGREEMENT_LABELS[key] ?? key;
}

export function perceptionConfidenceLabel(
  level: string | null | undefined,
  score: number | null | undefined,
): string {
  if (level === 'unknown' || score === null || score === undefined) return '证据不足（不给分）';
  return `可信度 ${level}（加权 ${Math.round(Number(score) * 100)}%）`;
}

export function buildPerceptionFusionView(fused: {
  subjectId: string;
  agreement: string;
  position: { x: number | null; y: number | null; stationId: string | null } | null;
  posture: { pitchDeg: number | null; action: string | null } | null;
  station: { stationId: string | null; basis: string; sources: string[] } | null;
  confidence: {
    level: string;
    score: number | null;
    usableSources: string[];
    degraded: boolean;
    missingSources: string[];
    excludedSources: Array<{ source: string; sourceId: string; status: string; reason: string }>;
  };
  conflicts: Array<{ dimension: string; severity: string; participants: Array<{ source: string; value: string }>; detail: string }>;
  strongAdviceAllowed: boolean;
  notes: string[];
}): PerceptionFusionView {
  const stationId = fused.station?.stationId ?? null;
  const positionKnown = fused.position !== null && (fused.position.x !== null || fused.position.y !== null);
  const postureParts: string[] = [];
  if (fused.posture?.pitchDeg !== null && fused.posture?.pitchDeg !== undefined) {
    postureParts.push(`俯仰 ${fused.posture.pitchDeg}°`);
  }
  if (fused.posture?.action) postureParts.push(`动作 ${fused.posture.action}`);
  const degradedLabel = fused.confidence.degraded
    ? `降级：缺 ${fused.confidence.missingSources.length} 个源 / 排除 ${fused.confidence.excludedSources.length} 条证据`
    : null;
  return {
    subjectId: fused.subjectId,
    agreementLabel: perceptionAgreementLabel(fused.agreement),
    agreementTone:
      fused.agreement === 'consistent'
        ? 'positive'
        : fused.agreement === 'conflict'
          ? 'critical'
          : fused.agreement === 'partial'
            ? 'warning'
            : 'neutral',
    stationLabel: stationId
      ? `工位 ${stationId}`
      : fused.position && positionKnown
        ? '工位未知（坐标已上报但未匹配到工位）'
        : '工位未知（无定位证据）',
    postureLabel: postureParts.length > 0 ? postureParts.join(' · ') : '姿态未知（无外骨骼/视觉证据）',
    confidenceLabel: perceptionConfidenceLabel(fused.confidence.level, fused.confidence.score),
    confidenceKnown: fused.confidence.level !== 'unknown' && fused.confidence.score !== null,
    degradedLabel,
    conflictLabels: fused.conflicts.map(
      (c) => `[${c.severity}] ${c.detail}（${c.participants.map((p) => `${p.source}=${p.value}`).join(' vs ')}）`,
    ),
    sourceLabel: fused.confidence.usableSources.length > 0
      ? `可用源：${fused.confidence.usableSources.join('、')}`
      : '可用源：无',
    missingLabel: fused.confidence.missingSources.length > 0
      ? `缺失源：${fused.confidence.missingSources.join('、')}`
      : null,
    excludedLabels: fused.confidence.excludedSources.map((e) => `${e.source}/${e.sourceId}：${e.reason}`),
    adviceLabel: fused.strongAdviceAllowed
      ? '可据此生成建议（仍受权限与审批约束）'
      : '**不得据此生成强建议**：低置信度或存在冲突（§5 规则 5）',
    notes: Array.isArray(fused.notes) ? fused.notes : [],
  };
}

/** 扫描摘要（读了什么 + 冲突/降级/未匹配都要可见）。 */
export function perceptionSweepLabel(result: {
  subjects: number;
  persisted: number;
  conflictSubjects: string[];
  degradedSubjects: string[];
  unmatchedVisionDetections: number;
  stationUnresolved: number;
  byAgreement: Record<string, number>;
  byConfidenceLevel: Record<string, number>;
}): string {
  const parts = [
    `主体 ${result.subjects} 个`,
    `快照 ${result.persisted} 条`,
    `一致 ${result.byAgreement.consistent ?? 0} / 部分 ${result.byAgreement.partial ?? 0} / 冲突 ${result.byAgreement.conflict ?? 0} / 证据不足 ${result.byAgreement.insufficient ?? 0}`,
    `可信度 高 ${result.byConfidenceLevel.high ?? 0} / 中 ${result.byConfidenceLevel.medium ?? 0} / 低 ${result.byConfidenceLevel.low ?? 0} / 未知 ${result.byConfidenceLevel.unknown ?? 0}`,
  ];
  if (result.conflictSubjects.length > 0) parts.push(`冲突主体 ${result.conflictSubjects.length} 个（优先看）`);
  if (result.degradedSubjects.length > 0) parts.push(`降级 ${result.degradedSubjects.length} 个`);
  if (result.unmatchedVisionDetections > 0) parts.push(`视觉未匹配 ${result.unmatchedVisionDetections} 条（未按"最像的人"分配）`);
  if (result.stationUnresolved > 0) parts.push(`工位未解析 ${result.stationUnresolved} 个（不猜最近工位）`);
  return parts.join(' · ');
}

/* ── NO-57b：预计 vs 实际 对账口径（§7 反馈腿）────────────────────────── */

export interface PlannedVsActualView {
  scopeLabel: string;
  /** 比率行：样本不足时明确写"证据不足（可比 N 条 / 门槛 5）"，不显示 0%。 */
  rateLabel: string;
  /** 计数行：超时/提前/准时。 */
  countLabel: string;
  /** 不可比分类（逐类可读）。 */
  reasonLabels: string[];
  deviationLabels: string[];
  biasNote: string | null;
  notes: string[];
  hasEvidence: boolean;
}

const REASON_LABELS: Record<string, string> = {
  comparable: '可比',
  missing_planned: '缺计划时间',
  missing_actual: '缺实际时间',
  zero_planned: '计划时长为 0',
  not_finished: '未完工（尚无实际时间）',
};

export function plannedVsActualReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

function formatMinutes(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${Math.round((ms / 60_000) * 10) / 10} 分钟`;
}

export function buildPlannedVsActualView(
  summary: {
    windowDays: number;
    totalRows: number;
    comparableRows: number;
    coverage: number | null;
    meanAbsPctError: number | null;
    medianAbsPctError: number | null;
    p90AbsPctError: number | null;
    meanSignedMs: number | null;
    overrunCount: number;
    underrunCount: number;
    onTimeCount: number;
    byReason: Record<string, number>;
    byDeviationType: Record<string, number>;
    biasNote: string | null;
    notes: string[];
  } | undefined | null,
): PlannedVsActualView {
  if (!summary) {
    return {
      scopeLabel: '尚未取到对账数据',
      rateLabel: '—',
      countLabel: '—',
      reasonLabels: [],
      deviationLabels: [],
      biasNote: null,
      notes: [],
      hasEvidence: false,
    };
  }
  const pct = (value: number | null) => (value === null ? null : `${Math.round(value * 100)}%`);
  const hasEvidence = summary.meanAbsPctError !== null;
  return {
    scopeLabel:
      `近 ${summary.windowDays} 天执行事实：共 ${summary.totalRows} 行，可比 ${summary.comparableRows} 行`
      + (summary.coverage === null ? '（覆盖率未知）' : `（覆盖率 ${Math.round(summary.coverage * 100)}%）`),
    rateLabel: hasEvidence
      ? `绝对偏差 中位 ${pct(summary.medianAbsPctError)} · 均值 ${pct(summary.meanAbsPctError)} · P90 ${pct(summary.p90AbsPctError)}`
      : `证据不足，不给偏差比率（可比 ${summary.comparableRows} 条 / 门槛 5）`,
    countLabel:
      `超时 ${summary.overrunCount} · 提前 ${summary.underrunCount} · 准时 ${summary.onTimeCount}`,
    reasonLabels: Object.entries(summary.byReason)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, count]) => `${plannedVsActualReasonLabel(reason)} ${count} 行`),
    deviationLabels: Object.entries(summary.byDeviationType)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([type, count]) => `${type} ${count} 次`),
    biasNote: summary.biasNote,
    notes: Array.isArray(summary.notes) ? summary.notes : [],
    hasEvidence,
  };
}

/** 平局均值（展示用；无样本返回 "—"）。 */
export function plannedVsActualMeanLabel(ms: number | null): string {
  return formatMinutes(ms);
}
