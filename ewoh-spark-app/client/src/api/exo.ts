import { axiosForBackend } from '../lib/http';
import { canonicalExoIdentity } from '../lib/exoIdentity';

/**
 * 外骨骼会话与配置 API 客户端（ADR-032 / §7）。
 *
 * 为什么需要单独一个客户端：`/api/exo/sessions` 与 `/api/exo/configs` 后端早已
 * 存在且带角色守卫，但前端一直没有调用入口——于是"外骨骼是工厂的感知与人机
 * 交互层"这一愿景在**产品层**是断的：现场人员看不到自己外骨骼的绑定与状态，
 * 也无法从现场视角回执。
 *
 * 边界（与 contracts/exo/exo-session.schema.json 一致，不在前端放宽）：
 *  - 会话绑定是显式、临时、可审计的 Session；终态不可复开，新绑定 = 新会话。
 *  - 本客户端只读会话/配置，并允许开始/结束会话。**不**下发任何关节、力矩、
 *    助力或限速指令——设备本地安全控制留在控制器，平台侧永不代理。
 */

export const EXO_SESSION_STATUSES = ['active', 'ended', 'aborted'] as const;
export type ExoSessionStatus = (typeof EXO_SESSION_STATUSES)[number];

/** 会话记录（后端返回行；仅列 UI 需要的字段）。 */
export interface ExoSessionRecord {
  sessionId: string;
  exoId: string;
  personId: string;
  status: ExoSessionStatus | string;
  startedAt: string;
  expectedEndAt?: string | null;
  actualEndAt?: string | null;
  endedBy?: string | null;
  operatorId?: string | null;
  orgId?: string | null;
  /** 变更轨迹（契约要求存在；用于"谁在何时改了什么"的追溯）。 */
  auditTrail?: unknown[];
  reason?: string | null;
  /** NO-40a：关联任务 id（缺省 = 未关联任何任务，不是"没有任务"）。 */
  taskId?: string;
  /** NO-40a：预计结束时间来源（operator=现场填写 / task_plan_end=继承任务计划）。 */
  expectedEndSource?: 'operator' | 'task_plan_end';
  /**
   * NO-44a：处置顺带关闭的提醒条数（只在刚刚发生处置的响应里出现；缺失 = 本次调用没有处置，
   * 不是"关闭了 0 条"）。`annotated` 指"已读行补写处置痕迹"的条数（状态不变）。
   */
  resolvedNotificationCount?: number;
  annotatedNotificationCount?: number;
  /**
   * NO-43a：佩戴人更正的两个指针（未经过更正 → 字段不出现）。
   * `correctedTo` = 本条因更正被交接给哪条新会话；`correctedFrom` = 本条由哪条会话更正而来。
   */
  correctedTo?: string;
  correctedFrom?: string;
  /**
   * NO-36b：服务端计算的时长/偏差事实（与 `shared/exo-session` 的纯函数同源）。
   * 页面仍可用共享纯函数本地计算（同一口径），此字段用于接口对账与其它消费方。
   */
  timing?: {
    durationMs: number | null;
    deviationMs: number | null;
    deviationState: 'unknown' | 'early' | 'on_time' | 'over';
    overdue: boolean;
    overdueMs: number | null;
    remainingMs: number | null;
  };
  [key: string]: unknown;
}

export interface StartExoSessionInput {
  sessionId?: string;
  exoId: string;
  personId: string;
  startedAt?: string;
  expectedEndAt?: string;
  operatorId?: string;
  /**
   * NO-40a：关联任务（可选）。绑定后未填 `expectedEndAt` 时服务端会继承任务的
   * 计划结束时间，并在响应里给出 `expectedEndSource`（operator / task_plan_end）。
   */
  taskId?: string;
  [key: string]: unknown;
}

export interface ExoConfigRecord {
  configId: string;
  exoId?: string;
  personId?: string;
  active?: boolean;
  fitStatus?: string | null;
  calibrationStatus?: string | null;
  [key: string]: unknown;
}

export async function listExoSessions(filters: {
  status?: string;
  exoId?: string;
} = {}): Promise<ExoSessionRecord[]> {
  const res = await axiosForBackend({
    url: '/api/exo/sessions',
    method: 'GET',
    params: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.exoId ? { exoId: filters.exoId } : {}),
    },
  });
  return normalizeList<ExoSessionRecord>(res.data, ['sessions', 'data', 'items']);
}

/**
 * NO-38a：会话偏差聚合（"预计 vs 实际"的运行记忆）。
 *
 * 服务端负责口径（只统计已收工会话、按开始时间窗口、上限截断标记），前端只展示。
 * 低于可比样本门槛时 `onTimeRate` 为 null——页面必须显示"证据不足"，不得显示 0%。
 */
export interface ExoDeviationGroup {
  key: string;
  sessions: number;
  completed: number;
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
  notes: string[];
}

export interface ExoDeviationSummary {
  generatedAt: string;
  windowDays: number;
  groupBy: 'device' | 'person';
  minSample: number;
  scanned: number;
  /** NO-42a：可比样本率（可比 / 已收工）；无样本 → null（不是 0%）。 */
  plannedCoverageRate: number | null;
  truncated: boolean;
  totals: ExoDeviationGroup;
  groups: ExoDeviationGroup[];
  notes: string[];
}

export async function getExoDeviationSummary(filters: {
  days?: number;
  groupBy?: 'device' | 'person';
} = {}): Promise<ExoDeviationSummary> {
  const res = await axiosForBackend({
    url: '/api/exo/sessions/deviation-summary',
    method: 'GET',
    params: {
      ...(filters.days ? { days: filters.days } : {}),
      ...(filters.groupBy ? { groupBy: filters.groupBy } : {}),
    },
  });
  return res.data as ExoDeviationSummary;
}

export interface ExoDeviceContextTask {
  taskId: string;
  title: string | null;
  status: string;
  assigneeId: string | null;
  planEnd: string | null;
}

export interface ExoDeviceContext {
  exoId: string;
  deviceUuid: string | null;
  registered: boolean;
  online: boolean | null;
  activeSession: {
    sessionId: string;
    personId: string;
    startedAt: string;
    expectedEndAt: string | null;
  } | null;
  inFlightTasks: ExoDeviceContextTask[];
  suggestion: {
    taskId: string | null;
    expectedEndAt: string | null;
    assigneeMatches: boolean;
    reason: string;
  };
  generatedAt: string;
}

/**
 * NO-40a：会话开始的设备上下文（只读）。
 *
 * 页面据此决定"绑定哪张任务、继承什么计划结束时间"；多任务时后端不给建议
 * （绑定是人的决定），页面必须如实展示原因而不是替人选择。
 */
export async function getExoDeviceContext(params: {
  exoId: string;
  personId?: string;
}): Promise<ExoDeviceContext> {
  const res = await axiosForBackend({
    url: '/api/exo/sessions/device-context',
    method: 'GET',
    params: {
      exoId: params.exoId,
      ...(params.personId ? { personId: params.personId } : {}),
    },
  });
  return res.data as ExoDeviceContext;
}

export const EXO_TELEMETRY_VERDICTS = [
  'consistent',
  'wearer_mismatch',
  'activity_only',
  'inactive_suspect',
  'stale_telemetry',
  'no_telemetry',
] as const;
export type ExoTelemetryVerdict = (typeof EXO_TELEMETRY_VERDICTS)[number];

export interface ExoTelemetryConsistencyItem {
  sessionId: string;
  exoId: string;
  personId: string | null;
  startedAt: string;
  expectedEndAt: string | null;
  taskId: string | null;
  verdict: ExoTelemetryVerdict;
  reason: string;
  needsHumanCheck: boolean;
  sessionPersonRef: string | null;
  telemetryWorkerRef: string | null;
  evidenceAgeMs: number | null;
  evidence: {
    ts: string;
    workerId: string | null;
    loadScore: number | null;
    assistLevel: number | null;
    angularVelocityDps: number | null;
    sourceType: string | null;
    dataQuality: string | null;
  } | null;
}

export interface ExoTelemetryConsistencyResponse {
  generatedAt: string;
  freshWindowMs: number;
  scanned: number;
  summary: Partial<Record<ExoTelemetryVerdict, number>>;
  sessions: ExoTelemetryConsistencyItem[];
  notes: string[];
}

/**
 * NO-41a：活跃会话的佩戴事实双源一致性（会话声明 × 设备遥测）。
 *
 * 页面必须**逐字**展示后端结论与理由：缺遥测是"无佐证"、不是"没在戴"；
 * 只有"帧里写明的佩戴人 ≠ 会话佩戴者"才是硬冲突（需人核实）。
 */
export async function getExoTelemetryConsistency(): Promise<ExoTelemetryConsistencyResponse> {
  const res = await axiosForBackend({
    url: '/api/exo/sessions/consistency',
    method: 'GET',
  });
  return res.data as ExoTelemetryConsistencyResponse;
}

export async function getExoSession(sessionId: string): Promise<ExoSessionRecord> {
  const res = await axiosForBackend({
    url: `/api/exo/sessions/${encodeURIComponent(sessionId)}`,
    method: 'GET',
  });
  return res.data as ExoSessionRecord;
}

export async function startExoSession(input: StartExoSessionInput): Promise<ExoSessionRecord> {
  const res = await axiosForBackend({
    url: '/api/exo/sessions',
    method: 'POST',
    data: {
      ...input,
      exoId: canonicalExoIdentity('device', input.exoId),
      personId: canonicalExoIdentity('person', input.personId),
    },
  });
  return res.data as ExoSessionRecord;
}

/** 结束会话。`endedBy` 由服务端在校验失败时兜底为当前操作者。 */
export async function endExoSession(
  sessionId: string,
  body: { endedBy?: string; reason?: string },
): Promise<ExoSessionRecord> {
  const res = await axiosForBackend({
    url: `/api/exo/sessions/${encodeURIComponent(sessionId)}/end`,
    method: 'POST',
    data: body,
  });
  return res.data as ExoSessionRecord;
}

/**
 * 中止会话（NO-33a：现场"没正常收工"必须留下理由）。
 *
 * 与 `endExoSession` 的区别是语义：end = 正常收工；abort = 异常/提前终止。
 * 两者都是终态且不可复开（ADR-032），理由进入会话事实。
 */
export async function abortExoSession(
  sessionId: string,
  body: { endedBy?: string; reason?: string },
): Promise<ExoSessionRecord> {
  const res = await axiosForBackend({
    url: `/api/exo/sessions/${encodeURIComponent(sessionId)}/abort`,
    method: 'POST',
    data: body,
  });
  return res.data as ExoSessionRecord;
}

/**
 * NO-43a：按实际佩戴人更正会话（人核实之后把结论落成事实）。
 *
 * 语义是"交接"而不是"改字段"：旧的错误会话带理由收工并指向新会话，新会话按实际佩戴人
 * 重开。历史两侧都保留——事后要能回答"谁戴过、谁核实的、依据是什么"。
 *
 * 平台自己不会调用它：遥测只是证据，必须由人（现场/班组长）确认后触发。
 */
export interface CorrectExoWearerResult {
  corrected: true;
  fromPersonId: string | null;
  toPersonId: string;
  reason: string;
  ended: ExoSessionRecord;
  started: ExoSessionRecord;
  /** NO-44a：随这次更正关闭的提醒条数（旧会话的待办不再挂着）。 */
  resolvedNotificationCount: number;
  annotatedNotificationCount: number;
}

export async function correctExoSessionWearer(
  sessionId: string,
  body: { personId: string; endedBy?: string; reason?: string },
): Promise<CorrectExoWearerResult> {
  const res = await axiosForBackend({
    url: `/api/exo/sessions/${encodeURIComponent(sessionId)}/correct-wearer`,
    method: 'POST',
    data: {
      ...body,
      personId: canonicalExoIdentity('person', body.personId),
    },
  });
  return res.data as CorrectExoWearerResult;
}

export async function listExoConfigs(): Promise<ExoConfigRecord[]> {
  const res = await axiosForBackend({ url: '/api/exo/configs', method: 'GET' });
  return normalizeList<ExoConfigRecord>(res.data, ['configs', 'data', 'items']);
}

/**
 * 兼容后端的多种列表包装（`{sessions: []}` / `{data: []}` / 裸数组 / `{items: []}`）。
 * 不猜测语义：只有确实是数组时才当作列表，否则返回空数组并由调用方显示"无数据"，
 * 绝不把结构不符误读成"没有外骨骼会话"以外的结论。
 */
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
