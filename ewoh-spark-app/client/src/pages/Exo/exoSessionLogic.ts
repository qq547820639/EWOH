/**
 * exoSessionLogic.ts — 外骨骼会话工作台的纯逻辑（NO-33a）。
 *
 * 为什么需要这一层：`/api/exo/sessions` 后端早已存在（ADR-032/033）、客户端 API 也已
 * 封装，但**没有任何页面消费它**——"外骨骼是工厂的感知与人机交互层"在**产品层**是断的：
 * 现场人员看不到自己外骨骼的会话状态，班组长也无法判断"谁还戴着没交回"。
 *
 * 这里只做可测试的展示逻辑，三条口径必须钉死：
 *   1. **时长**：进行中 = 至今（用调用方给的 now），终态 = 起止之差；时间非法 → null（不猜）；
 *   2. **长时间未收工**：超过阈值（默认 4 小时）明确提示"可能忘记收工/需核实"——
 *      这是现场真实会发生的事（人走了，会话还开着，设备被占用、后续派工判定失真）；
 *   3. **缺口如实**：缺设备号/人员/结束人时标注"未记录"，绝不补默认值；
 *   4. **预计 vs 实际**（NO-36b）：偏差由 `@shared/exo-session` 的纯函数统一计算
 *      （服务端响应与前端展示同一口径）——没填预计就没有偏差，绝不把"没记录"说成准时。
 */
import {
  EXO_LONG_SESSION_THRESHOLD_MS,
  projectExoSessionTiming,
  type ExoDeviationState,
} from '@shared/exo-session';

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  ended: '已结束',
  aborted: '已中止',
};
export function exoSessionStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? '').trim();
  if (!key) return '状态未知（未记录）';
  // 未登记状态原样透出（§33：不把未知说成已知）
  return STATUS_LABELS[key] ?? key;
}

/**
 * 长时间未收工阈值（4 小时）。
 *
 * NO-37a 起**单一来源在共享层**（`shared/exo-session.ts`）：页面告警与平台侧主动
 * 提醒必须同阈值，否则会出现"页面说正常、通知说超时"的分叉。这里保留旧名再导出，
 * 既有调用点与测试不受影响。
 */
export const LONG_SESSION_THRESHOLD_MS = EXO_LONG_SESSION_THRESHOLD_MS;

export interface ExoSessionLike {
  sessionId?: string | null;
  exoId?: string | null;
  personId?: string | null;
  status?: string | null;
  startedAt?: string | null;
  expectedEndAt?: string | null;
  actualEndAt?: string | null;
  endedBy?: string | null;
  reason?: string | null;
  operatorId?: string | null;
  /** NO-40a：关联任务 id（缺省 = 未关联任何任务）。 */
  taskId?: string | null;
  /** NO-40a：预计结束时间来源（operator=现场填写 / task_plan_end=继承任务计划）。 */
  expectedEndSource?: 'operator' | 'task_plan_end' | null;
  /** NO-43a：更正链路指针（未经过更正 → undefined，不显示）。 */
  correctedTo?: string | null;
  correctedFrom?: string | null;
}

export interface ExoSessionRow {
  sessionId: string;
  exoId: string | null;
  personId: string | null;
  status: string;
  statusLabel: string;
  startedAt: string | null;
  /** 已进行/持续时长（ms）；时间非法或缺失 → null。 */
  durationMs: number | null;
  durationLabel: string;
  expectedEndAt: string | null;
  /** NO-40a：预计结束时间来源（未记录 → null，页面不猜）。 */
  expectedEndSource: 'operator' | 'task_plan_end' | null;
  /** NO-40a：关联任务 id（未关联 → null）。 */
  taskId: string | null;
  /** NO-43a：本条被更正交接给的新会话（无 → null）；用于页面上显示"已交接"痕迹。 */
  correctedTo: string | null;
  /** NO-43a：本条由哪条会话更正而来（无 → null）。 */
  correctedFrom: string | null;
  actualEndAt: string | null;
  endedBy: string | null;
  reason: string | null;
  /** 相对预计结束的偏差（ms；>0 超时、<0 提前）；无预计或无实际结束 → null。 */
  deviationMs: number | null;
  /** 偏差判定（unknown/early/on_time/over）——无证据恒为 unknown。 */
  deviationState: ExoDeviationState;
  /** 偏差文案（"超时 1 小时 20 分"/"提前 15 分钟"/"在预计时间内"/"未记录预计结束时间"）。 */
  deviationLabel: string;
  /** 进行中且已过预计结束时间（该催收工的确定性依据）。 */
  overdue: boolean;
  /** 已超时多久（仅 overdue 时有值）。 */
  overdueMs: number | null;
  /** 进行中且尚未到预计结束：剩余时间。 */
  remainingMs: number | null;
  /** 进行中且超过阈值 → 提示核实（可能忘记收工）。 */
  needsAttention: boolean;
  attentionLabel: string | null;
  /** 正在进行中的会话（用于排序与统计）。 */
  isActive: boolean;
}

/**
 * 偏差文案（NO-36b）：把"预计 vs 实际"说成人话。
 * `unknown` 不是"准时"——而是"没记录预计结束时间/还没结束"，必须如实说明。
 */
export function formatDeviation(
  deviationMs: number | null,
  state: ExoDeviationState,
): string {
  if (state === 'unknown' || deviationMs === null || !Number.isFinite(deviationMs)) {
    return '未记录预计结束时间（无法比较预计与实际）';
  }
  const magnitude = formatDuration(Math.abs(deviationMs));
  if (state === 'early') return `提前 ${magnitude} 结束`;
  if (state === 'over') return `超时 ${magnitude} 结束`;
  return `在预计时间内结束（偏差 ${magnitude} 以内）`;
}

/** 时长文案：天/小时/分钟三档；不足 1 分钟显示"不足 1 分钟"；无法计算 → "时长未知"。 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return '时长未知';
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 1) return '不足 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

export function buildExoSessionRows(
  sessions: readonly ExoSessionLike[],
  options: { nowMs?: number; longSessionThresholdMs?: number } = {},
): ExoSessionRow[] {
  const nowMs = options.nowMs ?? Date.now();
  const threshold = options.longSessionThresholdMs ?? LONG_SESSION_THRESHOLD_MS;
  const rows = sessions.map((session): ExoSessionRow => {
    const status = String(session.status ?? '').trim();
    const isActive = status === 'active';
    // NO-36b：时长/偏差统一走共享纯函数（服务端 `timing` 字段同源），
    // 避免前端自己算一套、后端算一套导致"接口说超时、界面说准时"。
    const timing = projectExoSessionTiming({
      status,
      startedAt: session.startedAt ?? null,
      expectedEndAt: session.expectedEndAt ?? null,
      actualEndAt: session.actualEndAt ?? null,
    }, { nowMs });
    const durationMs = timing.durationMs;
    const needsAttention = isActive && durationMs !== null && durationMs >= threshold;
    return {
      sessionId: String(session.sessionId ?? '').trim() || '（会话号未记录）',
      exoId: (session.exoId ?? '')?.toString().trim() || null,
      personId: (session.personId ?? '')?.toString().trim() || null,
      status,
      statusLabel: exoSessionStatusLabel(status),
      startedAt: session.startedAt ?? null,
      durationMs,
      durationLabel: formatDuration(durationMs),
      expectedEndAt: session.expectedEndAt ?? null,
      // NO-40a：来源与关联任务——页面据此显示"（继承任务计划）"与任务号
      expectedEndSource:
        session.expectedEndSource === 'task_plan_end' || session.expectedEndSource === 'operator'
          ? session.expectedEndSource
          : null,
      taskId: (session.taskId ?? '').toString().trim() || null,
      // NO-43a：更正链路（缺失 → null，页面就不显示，不补默认值）
      correctedTo: (session.correctedTo ?? '').toString().trim() || null,
      correctedFrom: (session.correctedFrom ?? '').toString().trim() || null,
      actualEndAt: session.actualEndAt ?? null,
      deviationMs: timing.deviationMs,
      deviationState: timing.deviationState,
      deviationLabel: formatDeviation(timing.deviationMs, timing.deviationState),
      overdue: timing.overdue,
      overdueMs: timing.overdueMs,
      remainingMs: timing.remainingMs,
      endedBy: (session.endedBy ?? '')?.toString().trim() || null,
      reason: (session.reason ?? '')?.toString().trim() || null,
      needsAttention,
      attentionLabel: needsAttention
        ? `已连续佩戴 ${formatDuration(durationMs)}（超过 ${Math.round(threshold / 3_600_000)} 小时）：请核实是否忘记收工`
        : null,
      isActive,
    };
  });

  // 排序：进行中优先；同为进行中则**时长最长优先**（最可能出问题）；其余按开始时间倒序。
  return rows.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.isActive && b.isActive) {
      const diff = (b.durationMs ?? 0) - (a.durationMs ?? 0);
      if (diff !== 0) return diff;
    }
    return String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''));
  });
}

export function summarizeExoSessions(rows: readonly ExoSessionRow[]): {
  total: number;
  active: number;
  ended: number;
  aborted: number;
  attention: number;
  /** NO-36b：进行中且已超过预计结束时间的会话数（"该催收工"）。 */
  overdue: number;
  label: string;
} {
  const active = rows.filter((r) => r.status === 'active').length;
  const ended = rows.filter((r) => r.status === 'ended').length;
  const aborted = rows.filter((r) => r.status === 'aborted').length;
  const attention = rows.filter((r) => r.needsAttention).length;
  const overdue = rows.filter((r) => r.overdue).length;
  const label =
    rows.length === 0
      ? '当前没有外骨骼会话记录（开始会话后会出现在这里）'
      : `进行中 ${active} · 已结束 ${ended} · 已中止 ${aborted}` +
        (overdue > 0 ? `｜超过预计结束 ${overdue} 台` : '') +
        (attention > 0 ? `｜需核实未收工 ${attention} 台` : '');
  return { total: rows.length, active, ended, aborted, attention, overdue, label };
}

/** 中止会话必须写理由（与后端语义一致：结束事实要完整）。 */
export function abortReasonError(reason: string): string | null {
  return reason.trim().length === 0 ? '中止会话必须填写理由（记录"为什么没正常收工"）' : null;
}

/* ── NO-43a：按实际佩戴人更正（人核实 → 落成事实）────────────────────── */

/**
 * 遥测结论的严重度（越大越要人先看）。
 *
 * 为什么需要它：后端只对"帧里写明的佩戴人 ≠ 会话佩戴者"给 `needsHumanCheck`，
 * 但 `stale_telemetry`（证据过期）与 `inactive_suspect`（疑似离岗）同样是"需要人去问一句"
 * 的结论。页面若只按 `needsHumanCheck` 上色，这两种会被显示成中性灰——等于把待核实的
 * 事实降级成正常状态。这里是单一来源，页面与浏览器测试共用同一次序。
 */
export const EXO_VERDICT_SEVERITY: Record<string, number> = {
  wearer_mismatch: 5,
  inactive_suspect: 4,
  stale_telemetry: 3,
  activity_only: 2,
  no_telemetry: 1,
  consistent: 0,
};

/** 该结论是否应当以"需要人核实"的视觉/文案呈现（未知结论按 0 处理，不夸大）。 */
export function isExoVerdictActionable(verdict: string | null | undefined): boolean {
  return (EXO_VERDICT_SEVERITY[String(verdict ?? '').trim()] ?? 0) >= 3;
}

/** 比较用的裸人员 id（`person:<uuid>` 与 `<uuid>` 等价，ADR-006）。 */
function barePersonRef(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/^person:/, '');
}

/** 证据新鲜度文案（无时间 → 明说未记录，不用 0 冒充）。 */
export function formatEvidenceAge(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return '时间未记录';
  if (ageMs < 60_000) return '1 分钟内';
  return `${formatDuration(ageMs)}前`;
}

/**
 * 更正面板要展示的全部内容（NO-43a）。
 *
 * 决策原则要求"智能建议必须显示来源、时间、影响面、约束与风险"——所以更正按钮不是一个
 * 裸动作，而是一份**可核对的事实包**：证据来自哪一帧、多久以前、这次更正会动到哪些记录、
 * 有什么风险。`blockedReason !== null` 时按钮不可用，且必须把原因说清楚（不灰按钮不解释）。
 */
export interface WearerCorrectionPlan {
  /** 可执行 → 目标人员（`person:` 规范化形态）；不可执行 → null。 */
  targetPersonId: string | null;
  /** 证据摘要（来源=哪一帧、什么时间、上报了谁）。 */
  evidenceLabel: string;
  /** 影响面（旧会话怎么结束、新会话怎么开、设备占用是否释放）。 */
  impactLabel: string;
  /** 约束与风险（书面告知后再由人决定）。 */
  riskLabel: string;
  /** 不可执行的显式原因；null = 可执行。 */
  blockedReason: string | null;
}

interface ConsistencyLike {
  verdict: string;
  reason?: string | null;
  sessionPersonRef?: string | null;
  telemetryWorkerRef?: string | null;
  evidenceAgeMs?: number | null;
  evidence?: { ts?: string | null; workerId?: string | null } | null;
}

interface SessionLikeForCorrection {
  sessionId?: string | null;
  personId?: string | null;
  status?: string | null;
}

/**
 * 纯函数：遥测校验结论 + 会话 → 更正面板内容。
 *
 * 只把"遥测帧里写明的佩戴人"当作更正对象：`activity_only`（有人在用但没报佩戴人）、
 * `stale_telemetry`、`no_telemetry` 一律不可执行——**缺证据不等于事实**，平台不替人指认
 * 谁在戴。同一个人（裸 id 与 `person:` 前缀等价）也不算需要更正。
 */
export function planWearerCorrection(
  consistency: ConsistencyLike | null | undefined,
  session: SessionLikeForCorrection | null | undefined,
): WearerCorrectionPlan {
  const fromRef = barePersonRef(session?.personId ?? consistency?.sessionPersonRef ?? null);
  const impactBase =
    `旧会话（${fromRef || '未记录佩戴人'}）将以"佩戴人交接"结束并保留在台账；`
    + '同时为实际佩戴人新开一条进行中会话——设备仍被占用，不会自动交回。';
  const riskLabel =
    '证据来自设备上报，可能失真或滞后；更正会写入审计（谁核实、依据哪一帧）。'
    + '若现场判断与遥测相反，请改用"结束会话"或"中止"，不要用更正直书一个结论。';
  const base = { targetPersonId: null as string | null, impactLabel: impactBase, riskLabel };

  if (!session || String(session.status ?? '') !== 'active') {
    return { ...base, evidenceLabel: '无（会话不在进行中）', blockedReason: '只有进行中的会话才能更正佩戴人' };
  }
  if (!consistency) {
    return {
      ...base,
      evidenceLabel: '无（尚未取到该会话的遥测校验结论）',
      blockedReason: '缺少遥测校验结论：没有证据就不能更正，请刷新或等待遥测上报',
    };
  }

  const verdict = String(consistency.verdict ?? '');
  const workerRef = barePersonRef(consistency.telemetryWorkerRef ?? consistency.evidence?.workerId ?? null);
  const frameTs = consistency.evidence?.ts ?? null;
  const evidenceLabel =
    workerRef === ''
      ? `结论「${verdict}」未指名具体佩戴人（帧时间 ${frameTs ?? '未记录'}）`
      : `来源：设备遥测帧（${formatEvidenceAge(consistency.evidenceAgeMs)}，帧时间 ${frameTs ?? '未记录'}）`
        + `｜该帧上报的佩戴人 ${workerRef}`;

  if (verdict !== 'wearer_mismatch') {
    return {
      ...base,
      evidenceLabel,
      blockedReason:
        verdict === 'consistent'
          ? '遥测结论「consistent」与会话声明一致：没有需要更正的佩戴人'
          : `遥测结论为「${verdict}」：没有指名"别人在戴"，不能按遥测更正（平台不替人指认）`,
    };
  }
  if (workerRef === '') {
    return {
      ...base,
      evidenceLabel,
      blockedReason: '遥测判定佩戴人不符，但帧里没有佩戴人字段：无法确定更正对象',
    };
  }
  if (fromRef !== '' && fromRef === workerRef) {
    return {
      ...base,
      evidenceLabel,
      blockedReason: '遥测上报的佩戴人与会话已一致（无需更正）',
    };
  }
  return {
    targetPersonId: `person:${workerRef}`,
    evidenceLabel,
    impactLabel: `更正对象：${workerRef}。${impactBase}`,
    riskLabel,
    blockedReason: null,
  };
}

/* ── NO-38a：偏差复盘（运行记忆）的展示口径 ───────────────────────────── */

/** 偏差复盘的展示行（服务端只给事实与计数，前端只排版、不下新结论）。 */
export interface DeviationReviewRow {
  key: string;
  /** 组标签（设备号 / 人员 id）。 */
  label: string;
  /** 样本概览："可比 3 / 共 4 条（1 条不可比）"。 */
  sampleLabel: string;
  /** 准时率文案：样本不足时明确写"证据不足"，绝不显示 0%。 */
  onTimeRateLabel: string;
  /** 偏差概览："平均 +1 小时 20 分｜中位 +1 小时｜最差超时 2 小时"。 */
  deviationLabel: string;
  /** 该组的诚实说明（逐条展示）。 */
  notes: string[];
  insufficientSample: boolean;
  /** 有问题（超时次数 > 0）——用于排序与视觉提示。 */
  hasOver: boolean;
}

interface DeviationGroupLike {
  key: string;
  sessions: number;
  comparable: number;
  onTime: number;
  early: number;
  over: number;
  notComparable: number;
  onTimeRate: number | null;
  meanDeviationMs: number | null;
  medianDeviationMs: number | null;
  worstOverMs: number | null;
  bestEarlyMs: number | null;
  insufficientSample: boolean;
  notes?: string[];
}

/** 带符号的偏差文案（正=超时、负=提前）；null → "无". */
export function formatSignedDeviation(deviationMs: number | null): string {
  if (deviationMs === null || !Number.isFinite(deviationMs)) return '无';
  const sign = deviationMs > 0 ? '+' : deviationMs < 0 ? '−' : '±';
  return `${sign}${formatDuration(Math.abs(deviationMs))}`;
}

/**
 * 纯函数：偏差聚合 → 展示行（按"可比样本多、超时多"优先排序，问题排前面）。
 * 比率一律由服务端判定（`onTimeRate === null` = 证据不足），前端不重算、不补 0。
 */
export function buildDeviationReviewRows(groups: readonly DeviationGroupLike[]): DeviationReviewRow[] {
  return groups
    .map((group) => {
      const label = group.key === 'ALL' ? '合计' : group.key;
      const sampleLabel =
        `可比 ${group.comparable} / 共 ${group.sessions} 条` +
        (group.notComparable > 0 ? `（${group.notComparable} 条不可比）` : '');
      const onTimeRateLabel =
        group.onTimeRate === null
          ? '准时率：证据不足（不给比率）'
          : `准时率 ${Math.round(group.onTimeRate * 100)}%（${group.onTime}/${group.comparable}）`;
      const parts: string[] = [];
      if (group.meanDeviationMs !== null) parts.push(`平均 ${formatSignedDeviation(group.meanDeviationMs)}`);
      if (group.medianDeviationMs !== null) parts.push(`中位 ${formatSignedDeviation(group.medianDeviationMs)}`);
      if (group.worstOverMs !== null) parts.push(`最差超时 ${formatDuration(group.worstOverMs)}`);
      if (group.bestEarlyMs !== null) parts.push(`最多提前 ${formatDuration(group.bestEarlyMs)}`);
      return {
        key: group.key,
        label,
        sampleLabel,
        onTimeRateLabel,
        deviationLabel: parts.length > 0 ? parts.join('｜') : '暂无可计算的偏差',
        notes: Array.isArray(group.notes) ? group.notes : [],
        insufficientSample: group.insufficientSample,
        hasOver: group.over > 0,
      };
    })
    .sort((a, b) => {
      if (a.hasOver !== b.hasOver) return a.hasOver ? -1 : 1;
      if (a.insufficientSample !== b.insufficientSample) return a.insufficientSample ? 1 : -1;
      // 同档内按**机器键**（`ALL` / `EXO-n`）升序，不按 `label` 排。
      // 为什么：`label` 是给人看的中文（ALL → '合计'），用它当排序键会把排序结果
      // 绑在**本地化比较规则**上——`localeCompare` 下 'EXO-1' 排在 '合计' 之前，
      // 于是"合计行置顶"这个意图在中文环境下静默失效（曾实测到此回归）。
      // 机器键是 ASCII 且与界面语言无关，排序因此可复现、跨 locale 一致。
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}
