/**
 * notification-metrics.ts — 提醒治理与处置度量（NO-46a，运行记忆）。
 *
 * 为什么需要它：NO-44a/NO-45a 让"处置后提醒有终态"成立，但**没有人能回答管理问题**：
 *   · 现场到底处置得快不快？（从提醒产生到了结用了多久）
 *   · 哪些提醒反复出现？（同一台设备/同一张授权在持续制造噪音）
 *   · 有多少提醒被放着没人管？（待处理账龄）
 *   · 投递失败（飞书/邮件）有没有被漏掉？
 *
 * 本模块是**纯函数**：服务端取数（窗口 + 租户 + 可见性作用域 + 行数上限）后交给它聚合，
 * 客户端用同一实现做展示换算，避免"接口说一套、界面说另一套"。
 *
 * 诚实边界（原则 7）：
 *   · 处置时长只统计**可比**样本（`resolvedAt` 与 `createdAt` 都能解析且顺序合理），
 *     缺时间戳/时间倒流的行单独计数（notComparable），绝不按 0 参与统计；
 *   · 样本不足（< minSample）**不给处置率**（返回 null），页面必须显示"证据不足"；
 *   · 提醒类型由通知号的确定性规则**分类**，未登记的形态归入 `other`/`unknown`
 *     并原样保留 id 前缀——不猜成已知类型；
 *   · 投递状态（sent/failed）与处置状态（resolved）**分开计数**，互不掩盖。
 */

/* ── 提醒类型（封闭词表 + 确定性分类）────────────────────────────────── */

export const NOTIFICATION_KINDS = [
  /** 外骨骼会话超过预计结束（NO-37a 时间桶）。 */
  'session_overdue',
  /** 外骨骼会话连续佩戴过久（NO-37a 时间桶）。 */
  'session_long_running',
  /** 佩戴事实双源冲突：帧里写明的佩戴人 ≠ 会话佩戴者（NO-42a 证据桶）。 */
  'telemetry_wearer_mismatch',
  /** 疑似未佩戴/已离岗（证据桶，用词不升格为事实）。 */
  'telemetry_inactive_suspect',
  /** 执行边界授权即将失效（NO-30a）。 */
  'approval_expiring',
  /** 执行边界授权已失效（NO-30a）。 */
  'approval_expired',
  /** 安灯/andon 类提醒（开灯 + SLA 升级）。 */
  'andon',
  /** Agent 待批命令提醒（人审闸门）。 */
  'agent_approval',
  /** 数据质量告警的"待核实"提醒（NO-53a）。 */
  'data_quality',
  /** 改进行动项"逾期未完成"提醒（NO-56b）。 */
  'improvement_action',
  /** 执行边界授权复核未通过：命令被拒绝投递 / 未授权执行（NO-62a）。 */
  'control_authorization',
  /** 其它已登记前缀但未细分的提醒。 */
  'other',
  /** 完全无法识别的通知号（原样透出，不猜）。 */
  'unknown',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const KIND_LABELS: Record<NotificationKind, string> = {
  session_overdue: '会话超时未收工',
  session_long_running: '会话连续佩戴过久',
  telemetry_wearer_mismatch: '佩戴人与遥测不符',
  telemetry_inactive_suspect: '疑似未佩戴/已离岗',
  approval_expiring: '授权即将失效',
  approval_expired: '授权已失效',
  andon: '安灯异常',
  agent_approval: 'Agent 命令待审批',
  data_quality: '数据质量待核实',
  improvement_action: '改进行动项逾期',
  control_authorization: '执行授权复核拦截',
  other: '其它提醒',
  unknown: '未识别提醒',
};

export function notificationKindLabel(kind: string | null | undefined): string {
  const key = String(kind ?? '').trim() as NotificationKind;
  return KIND_LABELS[key] ?? String(kind ?? '');
}

/** 外骨骼提醒的类型标签（与 NO-37a/NO-42a 的确定性 id 规则一一对应，长标签在前避免误判）。 */
const EXO_TAGS: Array<{ tag: string; kind: NotificationKind }> = [
  { tag: 'telemetry_wearer_mismatch', kind: 'telemetry_wearer_mismatch' },
  { tag: 'telemetry_inactive_suspect', kind: 'telemetry_inactive_suspect' },
  { tag: 'long_running', kind: 'session_long_running' },
  { tag: 'overdue', kind: 'session_overdue' },
];

/**
 * 纯函数：通知号 → 提醒类型（封闭词表）。
 *
 * 规则来自各写入方的**确定性 id 约定**（不是从标题/正文猜语义）：
 *   `NTF-EXO-<会话清洗号>-<标签>[-user-<收件人>]-<渠道>`；
 *   `NTF-EXPR-<审批号>-<expiring|expired>[-user-<收件人>]-<渠道>`；
 *   `NTF-ANDON-…`。
 * 未登记前缀 → `other`（是平台通知但没细分）；完全不是 `NTF-` 开头 → `unknown`。
 */
export function classifyNotificationKind(notificationId: string): NotificationKind {
  const id = String(notificationId ?? '').trim();
  if (id === '') return 'unknown';
  if (id.startsWith('NTF-EXO-')) {
    const hit = EXO_TAGS.find(
      (candidate) => id.includes(`-${candidate.tag}-`) || id.endsWith(`-${candidate.tag}`),
    );
    return hit ? hit.kind : 'other';
  }
  if (id.startsWith('NTF-EXPR-')) {
    if (id.includes('-expiring-') || id.endsWith('-expiring')) return 'approval_expiring';
    if (id.includes('-expired-') || id.endsWith('-expired')) return 'approval_expired';
    return 'other';
  }
  if (id.startsWith('NTF-ANDON-')) return 'andon';
  if (id.startsWith('NTF-AGENT-')) return 'agent_approval';
  if (id.startsWith('NTF-DQ-')) return 'data_quality';
  if (id.startsWith('NTF-ACT-')) return 'improvement_action';
  if (id.startsWith('NTF-CTRL-')) return 'control_authorization';
  return id.startsWith('NTF-') ? 'other' : 'unknown';
}

/**
 * 通知号"族"登记表（**契约**：所有写入方必须在这里登记）。
 *
 * 为什么需要：通知号不只是标识，它是**幂等键**与**分类依据**。实测踩过两类问题：
 *   · 用随机 id 的写入方既不能幂等（重放就重复打扰），也无法被治理度量归类；
 *   · 度量词表里登记了 `andon`，但**没有任何写入方产生这种 id**——"死词表"，
 *     页面上这一类数字永远是 0，看起来像"很干净"，其实是"看不见"。
 * 因此有 `test/unit/notification/notification-id-families.spec.ts` 做双向门禁：
 *   · server 源码里出现的每个 `NTF-` 字面量前缀都必须在族表里登记；
 *   · 族表里每个族都必须能被 `classifyNotificationKind` 归到一个**已登记类型**；
 *   · 每个已登记类型都必须至少被一个族覆盖（不许有不可达类型）。
 */
export const NOTIFICATION_ID_FAMILIES = [
  {
    prefix: 'NTF-EXO-',
    writer: 'exo-session-reminder.service',
    // 同一族按"标签段"细分出多种类型（`NTF-EXO-<会话>-<标签>[-user-<人>]-<渠道>`）
    samples: [
      { id: 'NTF-EXO-exo-sessionS1-overdue-app', kind: 'session_overdue' },
      { id: 'NTF-EXO-exo-sessionS1-long_running-app', kind: 'session_long_running' },
      { id: 'NTF-EXO-exo-sessionS1-telemetry_wearer_mismatch-app', kind: 'telemetry_wearer_mismatch' },
      { id: 'NTF-EXO-exo-sessionS1-telemetry_inactive_suspect-user-worker.zhangwei-app', kind: 'telemetry_inactive_suspect' },
    ],
  },
  {
    prefix: 'NTF-EXPR-',
    writer: 'approval-expiry.service',
    samples: [
      { id: 'NTF-EXPR-AP-1-expiring-app', kind: 'approval_expiring' },
      { id: 'NTF-EXPR-AP-1-expired-user-approver.li-app', kind: 'approval_expired' },
    ],
  },
  {
    prefix: 'NTF-ANDON-',
    writer: 'andon-notifications',
    samples: [
      { id: 'NTF-ANDON-ANDON-1-raised-app', kind: 'andon' },
      { id: 'NTF-ANDON-ANDON-1-sla_escalation-lark', kind: 'andon' },
    ],
  },
  {
    prefix: 'NTF-AGENT-',
    writer: 'agent.service',
    samples: [{ id: 'NTF-AGENT-appr-1-pending-app', kind: 'agent_approval' }],
  },
  {
    prefix: 'NTF-DQ-',
    writer: 'data-quality-notification.service',
    samples: [
      { id: 'NTF-DQ-EVT-1-quality_alert-role-workshop_lead-app', kind: 'data_quality' },
      { id: 'NTF-DQ-EVT-1-quality_aging-user-worker.zhangwei-app', kind: 'data_quality' },
    ],
  },
  {
    prefix: 'NTF-CTRL-',
    writer: 'control.service',
    // `NTF-CTRL-<命令号>-<桶>-<role|user>-<收件人>-<渠道>`
    samples: [
      { id: 'NTF-CTRL-att-1-delivery_revoked-role-workshop_lead-app', kind: 'control_authorization' },
      { id: 'NTF-CTRL-att-1-unauthorized_execution-role-safety_admin-app', kind: 'control_authorization' },
      // NO-68a：投递积压（命令超 SLA 仍未交付；按设备聚合，收件人是值班/班组长/设备运维）
      { id: 'NTF-CTRL-AGV-01-delivery_backlog-role-dispatcher-app', kind: 'control_authorization' },
      // NO-70a：积压超 N 倍 SLA 升级给生产管理者（一级值班没处置动时的升级通道）
      { id: 'NTF-CTRL-AGV-01-delivery_backlog_escalated-role-production_manager-app', kind: 'control_authorization' },
    ],
  },
  {
    prefix: 'NTF-ACT-',
    writer: 'improvement-action.service',
    // `NTF-ACT-<行动项号>-action_overdue-<role|user>-<收件人>-<渠道>`
    samples: [
      { id: 'NTF-ACT-ACT-lesson-RTR-1-check-backup-abc-action_overdue-role-workshop_lead-app', kind: 'improvement_action' },
      { id: 'NTF-ACT-ACT-lesson-RTR-1-check-backup-abc-action_overdue-user-lead.chen-app', kind: 'improvement_action' },
    ],
  },
] as const satisfies ReadonlyArray<{
  prefix: string;
  writer: string;
  samples: ReadonlyArray<{ id: string; kind: NotificationKind }>;
}>;

/* ── 聚合 ─────────────────────────────────────────────────────────────── */

export interface NotificationMetricRow {
  notificationId?: string | null;
  status?: string | null;
  channel?: string | null;
  externalRef?: string | null;
  resolution?: string | null;
  createdAt?: string | null;
  readAt?: string | null;
  resolvedAt?: string | null;
}

export interface NotificationKindGroup {
  kind: NotificationKind;
  label: string;
  total: number;
  pending: number;
  read: number;
  resolved: number;
  /** 推送投递失败（运维事件，与处置无关）。 */
  failedDelivery: number;
  /** 可比样本数（处置时长可计算的行数）。 */
  comparable: number;
  /** 不可比样本数（缺时间戳/时间倒流）。 */
  notComparable: number;
  medianTimeToResolveMs: number | null;
  meanTimeToResolveMs: number | null;
  /** 该类型中最久未处置的待办年龄（无待办 → null）。 */
  oldestPendingAgeMs: number | null;
}

export interface NotificationAgingBucket {
  key: 'lt1h' | 'lt8h' | 'lt24h' | 'gte24h' | 'unknown';
  label: string;
  count: number;
}

export interface NotificationTopSource {
  /** 主事实引用（会话号/审批号）；无引用时统一归到"未关联主事实"。 */
  externalRef: string;
  kind: NotificationKind;
  kindLabel: string;
  total: number;
  pending: number;
  resolved: number;
}

export interface NotificationGovernanceSummary {
  generatedAt: string;
  windowDays: number;
  minSample: number;
  /** 窗口内扫描到的通知条数。 */
  scanned: number;
  /** 命中取数上限（结论只覆盖已取到的行）。 */
  truncated: boolean;
  totals: {
    total: number;
    pending: number;
    read: number;
    resolved: number;
    failedDelivery: number;
  };
  /**
   * 处置率 = 已处置 / 扫描条数；样本 < minSample → **null**（页面显示"证据不足"）。
   */
  dispositionRate: number | null;
  /** 处置时长中位数/均值（只统计可比样本；无样本 → null）。 */
  medianTimeToResolveMs: number | null;
  meanTimeToResolveMs: number | null;
  comparable: number;
  notComparable: number;
  /** 待处理提醒的账龄分布（"有多少被放着没人管"）。 */
  aging: NotificationAgingBucket[];
  byKind: NotificationKindGroup[];
  /** 反复出现的主事实（Top 5，按总数倒序，同数按引用稳定排序）。 */
  topSources: NotificationTopSource[];
  notes: string[];
}

const AGING_LABELS: Record<NotificationAgingBucket['key'], string> = {
  lt1h: '1 小时内',
  lt8h: '1–8 小时',
  lt24h: '8–24 小时',
  gte24h: '超过 24 小时',
  unknown: '时间未记录',
};

const DEFAULTS = { windowDays: 30, minSample: 3, topSources: 5 } as const;

function parseMs(value: string | null | undefined): number | null {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function statusOf(row: NotificationMetricRow): string {
  return String(row.status ?? '').trim() || 'unknown';
}

/**
 * 纯函数：通知行 → 治理度量。
 *
 * 只做聚合与口径判定，不做任何"补 0 / 猜时间 / 猜类型"的动作。
 */
export function summarizeNotificationDisposition(
  rows: readonly NotificationMetricRow[],
  options: { now?: Date; windowDays?: number; minSample?: number; topSources?: number } = {},
): NotificationGovernanceSummary {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const windowDays = Number.isFinite(options.windowDays) ? Number(options.windowDays) : DEFAULTS.windowDays;
  const minSample = Number.isFinite(options.minSample) ? Number(options.minSample) : DEFAULTS.minSample;
  const topN = Number.isFinite(options.topSources) ? Number(options.topSources) : DEFAULTS.topSources;

  const totals = { total: 0, pending: 0, read: 0, resolved: 0, failedDelivery: 0 };
  const bucketCounts: Record<NotificationAgingBucket['key'], number> = {
    lt1h: 0,
    lt8h: 0,
    lt24h: 0,
    gte24h: 0,
    unknown: 0,
  };
  const byKind = new Map<NotificationKind, NotificationKindGroup & { durations: number[] }>();
  const bySource = new Map<string, NotificationTopSource>();
  const durations: number[] = [];
  let comparable = 0;
  let notComparable = 0;

  for (const row of rows) {
    const status = statusOf(row);
    const kind = classifyNotificationKind(String(row.notificationId ?? ''));
    totals.total += 1;
    if (status === 'pending') totals.pending += 1;
    else if (status === 'read') totals.read += 1;
    else if (status === 'resolved') totals.resolved += 1;
    else if (status === 'failed') totals.failedDelivery += 1;

    if (!byKind.has(kind)) {
      byKind.set(kind, {
        kind,
        label: KIND_LABELS[kind],
        total: 0,
        pending: 0,
        read: 0,
        resolved: 0,
        failedDelivery: 0,
        comparable: 0,
        notComparable: 0,
        medianTimeToResolveMs: null,
        meanTimeToResolveMs: null,
        oldestPendingAgeMs: null,
        durations: [],
      });
    }
    const group = byKind.get(kind)!;
    group.total += 1;
    if (status === 'pending') group.pending += 1;
    else if (status === 'read') group.read += 1;
    else if (status === 'resolved') group.resolved += 1;
    else if (status === 'failed') group.failedDelivery += 1;

    const createdAtMs = parseMs(row.createdAt);
    // 处置时长：只统计"已处置且两端时间戳可用且顺序合理"的行。
    if (status === 'resolved') {
      const resolvedAtMs = parseMs(row.resolvedAt);
      if (createdAtMs !== null && resolvedAtMs !== null && resolvedAtMs >= createdAtMs) {
        const duration = resolvedAtMs - createdAtMs;
        durations.push(duration);
        group.durations.push(duration);
        group.comparable += 1;
        comparable += 1;
      } else {
        group.notComparable += 1;
        notComparable += 1;
      }
    }

    // 待处理账龄：无法解析创建时间 → 明确归入"时间未记录"。
    if (status === 'pending') {
      if (createdAtMs === null) {
        bucketCounts.unknown += 1;
      } else {
        const age = Math.max(0, nowMs - createdAtMs);
        if (age < 3_600_000) bucketCounts.lt1h += 1;
        else if (age < 8 * 3_600_000) bucketCounts.lt8h += 1;
        else if (age < 24 * 3_600_000) bucketCounts.lt24h += 1;
        else bucketCounts.gte24h += 1;
        const groupOldest = group.oldestPendingAgeMs;
        if (groupOldest === null || age > groupOldest) group.oldestPendingAgeMs = age;
      }
    }

    // 反复出现的提醒：按主事实（externalRef）聚合。
    const ref = String(row.externalRef ?? '').trim() || '（未关联主事实）';
    if (!bySource.has(ref)) {
      bySource.set(ref, {
        externalRef: ref,
        kind,
        kindLabel: KIND_LABELS[kind],
        total: 0,
        pending: 0,
        resolved: 0,
      });
    }
    const source = bySource.get(ref)!;
    source.total += 1;
    if (status === 'pending') source.pending += 1;
    if (status === 'resolved') source.resolved += 1;
  }

  const kindGroups: NotificationKindGroup[] = [...byKind.values()]
    .map(({ durations: groupDurations, ...rest }) => ({
      ...rest,
      medianTimeToResolveMs: median(groupDurations),
      meanTimeToResolveMs:
        groupDurations.length > 0
          ? Math.round(groupDurations.reduce((sum, value) => sum + value, 0) / groupDurations.length)
          : null,
    }))
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));

  const topSources = [...bySource.values()]
    .sort((a, b) => b.total - a.total || a.externalRef.localeCompare(b.externalRef))
    .slice(0, Math.max(0, topN));

  const scanned = totals.total;
  return {
    generatedAt: now.toISOString(),
    windowDays,
    minSample,
    scanned,
    truncated: false,
    totals,
    dispositionRate: scanned >= minSample && scanned > 0 ? totals.resolved / scanned : null,
    medianTimeToResolveMs: median(durations),
    meanTimeToResolveMs:
      durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null,
    comparable,
    notComparable,
    aging: (Object.keys(AGING_LABELS) as Array<NotificationAgingBucket['key']>).map((key) => ({
      key,
      label: AGING_LABELS[key],
      count: bucketCounts[key],
    })),
    byKind: kindGroups,
    topSources,
    notes: [
      `口径：按**创建时间**取最近 ${windowDays} 天，且仅统计当前调用者可见的通知（租户 + 角色/点名到人作用域）。`,
      '处置率 = 已处置条数 / 扫描条数；扫描样本少于 ' +
        `${minSample} 条时不给比率（返回 null，页面显示"证据不足"）。`,
      '处置时长只统计"已处置且创建/处置时间都可解析且顺序合理"的样本；缺时间戳或时间倒流的行计入不可比，不按 0 参与统计。',
      '推送投递失败（failed）单独计数：它是投递事实，不是"没处置"，两者不能互相掩盖。',
      '提醒类型由通知号的确定性规则分类；未登记形态归入"其它/未识别"，不猜成已知类型。',
    ],
  };
}
