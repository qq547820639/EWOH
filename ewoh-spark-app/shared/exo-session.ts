/* 前后端共享契约 - Canonical Exo Session（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 * 权威契约：contracts/exo/exo-session.schema.json + exo-session.test-vectors.json。
 * 语义与 src/edge_platform/contracts/exo_session.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';

export const EXO_SESSION_STATUSES = ['active', 'ended', 'aborted'] as const;
export type ExoSessionStatus = (typeof EXO_SESSION_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(EXO_SESSION_STATUSES);

const REQUIRED_FIELDS = ['sessionId', 'exoId', 'personId', 'status', 'startedAt', 'auditTrail'] as const;

function isIso(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

function isoTs(value: unknown): number {
  return Date.parse(String(value));
}

/** 校验外骨骼会话记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateExoSession(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.sessionId !== 'string' || !r.sessionId.startsWith('exo-session:')) {
    return ['bad_session_id'];
  }
  const exoId = r.exoId;
  // SH-001：与 Python is_canonical_identity 对齐（value 限 [A-Za-z0-9._~@-]），
  // 弃用宽松 regex（不限 value 字符集，TS 放行 Python 拒绝的 ID）。
  if (typeof exoId !== 'string' || !isCanonicalIdentity(exoId) || !exoId.startsWith('device:')) {
    return ['bad_exo_identity'];
  }
  const personId = r.personId;
  if (typeof personId !== 'string' || !isCanonicalIdentity(personId) || !personId.startsWith('person:')) {
    return ['bad_person_identity'];
  }
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (!isIso(r.startedAt)) return ['bad_start_time'];
  const actualEnd = r.actualEndAt;
  const status = String(r.status);
  if (status === 'ended' || status === 'aborted') {
    if (!isIso(actualEnd)) return ['actual_end_required'];
    if (isoTs(actualEnd) < isoTs(r.startedAt)) return ['bad_time_order'];
    if (typeof r.endedBy !== 'string' || r.endedBy.trim() === '') return ['ended_by_required'];
  } else if (actualEnd !== undefined) {
    return ['actual_end_not_allowed'];
  }
  if (r.expectedEndAt !== undefined && !isIso(r.expectedEndAt)) return ['bad_expected_end'];
  if (r.operatorId !== undefined && (typeof r.operatorId !== 'string' || r.operatorId === '')) {
    return ['bad_operator'];
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}

/**
 * NO-40a：预计结束时间的**来源**（封闭词表；缺失即"未记录"，绝不冒充）。
 *
 * 为什么需要它：会话的 `expectedEndAt` 可能来自现场填写、也可能继承自关联任务的
 * 计划结束时间。两者对偏差复盘的含义不同——现场填的是人的承诺，继承的是调度计划；
 * 界面上必须能区分（原则 5：智能建议要显示来源）。
 */
export const EXO_EXPECTED_END_SOURCES = ['operator', 'task_plan_end'] as const;
export type ExoExpectedEndSource = (typeof EXO_EXPECTED_END_SOURCES)[number];

/** ADR-032 状态机：active→{ended, aborted}；终态不可复开。 */
export function exoSessionTransitionAllowed(fromStatus: string, toStatus: string): boolean {
  return fromStatus === 'active' && (toStatus === 'ended' || toStatus === 'aborted');
}

/* ------------------------------------------------------------------ */
/* NO-36b：会话时长与「预计 vs 实际」偏差（运行记忆）                   */
/* ------------------------------------------------------------------ */

/**
 * 偏差判定词表（封闭）：
 * - `unknown`：没有预计结束时间 / 尚未结束 / 时间不可解析 —— 无证据就不是"准时"；
 * - `early`  ：实际结束早于预计（提前收工）；
 * - `on_time`：与预计的偏差在容差内；
 * - `over`   ：实际结束晚于预计（超时）。
 */
export const EXO_DEVIATION_STATES = ['unknown', 'early', 'on_time', 'over'] as const;
export type ExoDeviationState = (typeof EXO_DEVIATION_STATES)[number];

/** 判定"准时"的容差（默认 ±5 分钟）——小于该量级的偏差不构成事实差异。 */
export const EXO_ON_TIME_TOLERANCE_MS = 5 * 60_000;

export interface ExoSessionTimingInput {
  status?: string | null;
  startedAt?: string | null;
  expectedEndAt?: string | null;
  actualEndAt?: string | null;
}

export interface ExoSessionTiming {
  /** 已进行（进行中）或总时长（终态）；时间不可解析 → null。 */
  durationMs: number | null;
  /** 相对预计结束的偏差：>0 超时、<0 提前；无预计或无实际结束 → null。 */
  deviationMs: number | null;
  /** 偏差判定（无证据 → unknown，绝不把"没记录预计"说成准时）。 */
  deviationState: ExoDeviationState;
  /** 进行中且已过预计结束时间（现场最该被提醒的事实）。 */
  overdue: boolean;
  /** 已超时多久（仅 overdue 为 true 时有值）。 */
  overdueMs: number | null;
  /** 进行中且尚未到预计结束：还需多久（仅未超时有值）。 */
  remainingMs: number | null;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 投影会话的时间事实（纯函数，前后端共用；服务端响应与前端展示同一口径）。
 *
 * 口径（原则 7：不把缺失/延迟伪造成确定事实）：
 * - 进行中：duration = now - startedAt（now 由调用方给出，可用固定时钟测试）；
 * - 终态：duration = actualEndAt - startedAt；缺 actualEndAt → null（不拿 now 冒充）；
 * - deviation 只在「有预计 + 有实际结束 + 两者都可解析」时给出，否则 null / unknown；
 * - overdue 只在进行中且 now > expectedEndAt 时为真（这就是"该催收工"的确定性依据）。
 */
export function projectExoSessionTiming(
  input: ExoSessionTimingInput,
  options: { nowMs?: number; onTimeToleranceMs?: number } = {},
): ExoSessionTiming {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const tolerance = Number.isFinite(options.onTimeToleranceMs)
    ? Math.max(0, Number(options.onTimeToleranceMs))
    : EXO_ON_TIME_TOLERANCE_MS;
  const startedMs = parseIsoMs(input.startedAt);
  const expectedMs = parseIsoMs(input.expectedEndAt);
  const actualEndMs = parseIsoMs(input.actualEndAt);
  const status = String(input.status ?? '').trim();
  const isActive = status === 'active';

  const durationMs =
    startedMs === null
      ? null
      : isActive
        ? Math.max(0, nowMs - startedMs)
        : actualEndMs === null
          ? null
          : Math.max(0, actualEndMs - startedMs);

  const deviationMs =
    expectedMs === null || actualEndMs === null ? null : actualEndMs - expectedMs;

  let deviationState: ExoDeviationState = 'unknown';
  if (deviationMs !== null) {
    if (deviationMs < -tolerance) deviationState = 'early';
    else if (deviationMs > tolerance) deviationState = 'over';
    else deviationState = 'on_time';
  }

  const overdue = isActive && expectedMs !== null && nowMs > expectedMs;
  const remainingMs = isActive && expectedMs !== null && nowMs <= expectedMs ? expectedMs - nowMs : null;

  return {
    durationMs,
    deviationMs,
    deviationState,
    overdue,
    overdueMs: overdue ? nowMs - (expectedMs as number) : null,
    remainingMs,
  };
}

/* ------------------------------------------------------------------ */
/* NO-37a：会话提醒（平台侧主动提醒，而不是等人打开页面）              */
/* ------------------------------------------------------------------ */

/**
 * 长时间未收工阈值：4 小时（一个班次内合理的连续佩戴上限）。
 *
 * 为什么放在共享层：页面告警与平台侧提醒必须是**同一个阈值**，
 * 否则会出现"页面说正常、通知说超时"的分叉（前端 `exoSessionLogic` 直接引用本常量）。
 */
export const EXO_LONG_SESSION_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/**
 * 超过预计结束后的提醒宽限（15 分钟）：5 分钟的轻微超时不值得打断班组长，
 * 但"超过预计一刻钟还没收工"就是需要人核实的现场事实。
 */
export const EXO_OVERDUE_REMINDER_GRACE_MS = 15 * 60 * 1000;

/** 提醒桶（封闭词表）：超过预计结束 / 长时间未收工。 */
export const EXO_REMINDER_BUCKETS = ['overdue', 'long_running'] as const;
export type ExoReminderBucket = (typeof EXO_REMINDER_BUCKETS)[number];

export interface ExoSessionReminderDecision {
  bucket: ExoReminderBucket;
  /** 已超时多久（仅 overdue 桶有值）。 */
  overdueMs: number | null;
  /** 已佩戴多久（无法计算 → null，不编造）。 */
  durationMs: number | null;
}

/**
 * 判定一条会话是否需要提醒（纯函数；服务端扫描与单测共用）。
 *
 * 语义（原则 5/7：提醒必须基于确定事实，缺证据不提醒也不编造）：
 * - 只对 `active` 会话提醒（终态已经收工，不需要核实）；
 * - `overdue`：已过预计结束时间且超出宽限 → 优先（严重度更高）；
 * - `long_running`：连续佩戴达到阈值（即使没填预计结束时间也要提醒——
 *   "没记录计划"不等于"可以一直戴着"）；
 * - 时间不可解析 → 返回 null（不猜、不误报）。
 */
export function classifyExoSessionReminder(
  input: ExoSessionTimingInput,
  options: {
    nowMs?: number;
    longRunningThresholdMs?: number;
    overdueGraceMs?: number;
  } = {},
): ExoSessionReminderDecision | null {
  const status = String(input.status ?? '').trim();
  if (status !== 'active') return null;
  const threshold = Number.isFinite(options.longRunningThresholdMs)
    ? Math.max(0, Number(options.longRunningThresholdMs))
    : EXO_LONG_SESSION_THRESHOLD_MS;
  const grace = Number.isFinite(options.overdueGraceMs)
    ? Math.max(0, Number(options.overdueGraceMs))
    : EXO_OVERDUE_REMINDER_GRACE_MS;
  const timing = projectExoSessionTiming(input, { nowMs: options.nowMs });
  if (timing.overdue && (timing.overdueMs ?? 0) >= grace) {
    return { bucket: 'overdue', overdueMs: timing.overdueMs, durationMs: timing.durationMs };
  }
  // 已经开始时刻无法解析 → 时长未知 → 不做"长时间"判定（缺数据不伪造事实）。
  if (timing.durationMs !== null && timing.durationMs >= threshold) {
    return { bucket: 'long_running', overdueMs: null, durationMs: timing.durationMs };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* NO-38a：会话偏差的"经验"聚合（运行记忆 → 可判定的结论）              */
/* ------------------------------------------------------------------ */

/**
 * 形成结论所需的最少可比样本数。
 *
 * 为什么必须有门槛：1 次超时就宣布"这台设备总是超时"是把噪声当事实（原则 7）。
 * 低于门槛时**不给比率**（返回 null + notes 说明），只给原始计数。
 */
export const EXO_DEVIATION_MIN_SAMPLE = 3;

export interface ExoDeviationSample {
  sessionId: string;
  /** 业务设备号（从 `device:<id>` 解析；无法解析 → null）。 */
  deviceId: string | null;
  /** 佩戴者（原样，含 `person:` 前缀）。 */
  personId: string | null;
  status: string;
  expectedEndAt?: string | null;
  actualEndAt?: string | null;
}

export interface ExoDeviationGroup {
  /** 分组键（`ALL` 为合计）。 */
  key: string;
  /** 窗口内的会话总数。 */
  sessions: number;
  /** 已收工（ended/aborted 且有实际结束时间）。 */
  completed: number;
  /** 可比样本：同时有预计结束与实际结束（才能算偏差）。 */
  comparable: number;
  onTime: number;
  early: number;
  over: number;
  /** 不可比：缺预计结束或缺实际结束（缺失 ≠ 准时）。 */
  notComparable: number;
  /** 准时率 = onTime / comparable；可比样本 < minSample 时为 null（不给假结论）。 */
  onTimeRate: number | null;
  meanDeviationMs: number | null;
  medianDeviationMs: number | null;
  /** 最严重的超时（仅 over 样本；无则 null）。 */
  worstOverMs: number | null;
  /** 提前最多的量（仅 early 样本的绝对值；无则 null）。 */
  bestEarlyMs: number | null;
  /** 可比样本是否不足以形成结论。 */
  insufficientSample: boolean;
  /** 该组的事实说明（样本不足、全部不可比等，必须能被人读到）。 */
  notes: string[];
}

export interface ExoDeviationSummary {
  generatedAt: string;
  windowDays: number;
  groupBy: 'device' | 'person';
  minSample: number;
  /** 窗口内扫描到的会话数（截断前的真实计数由 truncated 标记）。 */
  scanned: number;
  /**
   * NO-42a：**可比样本率** = 可比会话 / 已收工会话。
   *
   * 为什么单列这个指标：NO-40a 让"预计结束时间"可以从关联任务继承，
   * 但"改进是否真的发生"必须可度量——否则"偏差复盘"长期停留在计数层面。
   * 无样本 → null（不是 0%，避免把"没有数据"读成"覆盖率为零"）。
   */
  plannedCoverageRate: number | null;
  /** 结果集是否被上限截断（截断时如实标记，避免"看起来是全部历史"）。 */
  truncated: boolean;
  totals: ExoDeviationGroup;
  groups: ExoDeviationGroup[];
  /** 全局口径说明（前端必须展示，避免把"不可比"读成"准时"）。 */
  notes: string[];
}

function emptyGroup(key: string): ExoDeviationGroup {
  return {
    key,
    sessions: 0,
    completed: 0,
    comparable: 0,
    onTime: 0,
    early: 0,
    over: 0,
    notComparable: 0,
    onTimeRate: null,
    meanDeviationMs: null,
    medianDeviationMs: null,
    worstOverMs: null,
    bestEarlyMs: null,
    insufficientSample: true,
    notes: [],
  };
}

function finalizeGroup(group: ExoDeviationGroup, deviations: number[], minSample: number): ExoDeviationGroup {
  const comparable = deviations.length;
  group.comparable = comparable;
  group.notComparable = group.sessions - comparable;
  group.insufficientSample = comparable < minSample;
  const notes = [...group.notes];
  if (group.sessions === 0) {
    notes.push('该分组在窗口内没有会话记录');
  } else if (comparable === 0) {
    notes.push('没有可比样本：这些会话没有同时记录"预计结束"与"实际结束"，无法比较预计与实际');
  } else {
    const sorted = [...deviations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    group.medianDeviationMs =
      sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    group.meanDeviationMs = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
    group.onTimeRate = group.insufficientSample ? null : group.onTime / comparable;
    if (group.insufficientSample) {
      notes.push(`可比样本仅 ${comparable} 条（少于 ${minSample} 条）：只给计数，不给准时率结论`);
    }
    if (group.notComparable > 0) {
      notes.push(`另有 ${group.notComparable} 条不可比（缺预计结束或缺实际结束），未计入比率`);
    }
  }
  group.notes = notes;
  return group;
}

/**
 * 把会话偏差聚合成"经验"（纯函数；服务端 API 与测试共用）。
 *
 * 口径（原则 5/7）：
 * - 只有 ended/aborted **且有实际结束时间** 的会话才谈得上"完成"；
 * - 只有同时有"预计结束 + 实际结束"的会话才**可比**（deviation ≠ null）；
 * - 准时率只在可比样本 ≥ minSample 时给出，否则 null + 说明（绝不用 0 冒充）；
 * - 缺时间戳的会话计入 notComparable 并显式说明，不静默丢弃。
 */
export function summarizeExoSessionDeviations(
  samples: readonly ExoDeviationSample[],
  options: { nowMs?: number; windowDays?: number; groupBy?: 'device' | 'person'; minSample?: number } = {},
): ExoDeviationSummary {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const windowDays = Number.isFinite(options.windowDays) && Number(options.windowDays) > 0
    ? Math.min(365, Math.floor(Number(options.windowDays)))
    : 30;
  const groupBy = options.groupBy === 'person' ? 'person' : 'device';
  const minSample = Number.isFinite(options.minSample) && Number(options.minSample) > 0
    ? Math.max(1, Math.floor(Number(options.minSample)))
    : EXO_DEVIATION_MIN_SAMPLE;

  const totals = emptyGroup('ALL');
  const totalsDeviations: number[] = [];
  const buckets = new Map<string, { group: ExoDeviationGroup; deviations: number[] }>();
  const addTo = (bucket: { group: ExoDeviationGroup; deviations: number[] }, sample: ExoDeviationSample) => {
    const group = bucket.group;
    group.sessions += 1;
    const timing = projectExoSessionTiming({
      status: sample.status,
      startedAt: null,
      expectedEndAt: sample.expectedEndAt ?? null,
      actualEndAt: sample.actualEndAt ?? null,
    });
    if (sample.actualEndAt) group.completed += 1;
    if (timing.deviationMs === null) return;
    bucket.deviations.push(timing.deviationMs);
    if (timing.deviationState === 'early') {
      group.early += 1;
      group.bestEarlyMs = Math.max(group.bestEarlyMs ?? 0, Math.abs(timing.deviationMs));
    } else if (timing.deviationState === 'over') {
      group.over += 1;
      group.worstOverMs = Math.max(group.worstOverMs ?? 0, timing.deviationMs);
    } else {
      group.onTime += 1;
    }
  };

  for (const sample of samples) {
    addTo({ group: totals, deviations: totalsDeviations }, sample);
    const key =
      groupBy === 'device'
        ? sample.deviceId ?? '设备未记录'
        : sample.personId ?? '人员未记录';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { group: emptyGroup(key), deviations: [] };
      buckets.set(key, bucket);
    }
    addTo(bucket, sample);
  }

  const totalsFinal = finalizeGroup(totals, totalsDeviations, minSample);
  const groups = [...buckets.values()]
    .map((bucket) => finalizeGroup(bucket.group, bucket.deviations, minSample))
    .sort((a, b) => {
      // 问题优先：可比样本多的在前；同数量按超时次数降序；再按 key。
      if (b.comparable !== a.comparable) return b.comparable - a.comparable;
      if (b.over !== a.over) return b.over - a.over;
      return a.key.localeCompare(b.key);
    });

  const notes = [
    '口径：只有同时记录了"预计结束"与"实际结束"的会话才可比；缺任一时间戳的会话计入不可比，不参与比率。',
    `形成结论的最少可比样本：${minSample} 条（低于该门槛只给计数，不给比率）。`,
  ];
  if (totalsFinal.notComparable > 0) {
    notes.push(
      `窗口内 ${totalsFinal.notComparable} 条会话不可比（多为未填预计结束时间）：这些会话的"准时"与否无证据，未被计入。`,
    );
  }
  if (groups.some((group) => group.insufficientSample)) {
    notes.push('存在样本不足的分组：其准时率为空是"证据不足"，不是"表现良好"。');
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays,
    groupBy,
    minSample,
    scanned: samples.length,
    plannedCoverageRate: totalsFinal.sessions > 0 ? totalsFinal.comparable / totalsFinal.sessions : null,
    truncated: false,
    totals: totalsFinal,
    groups,
    notes,
  };
}
