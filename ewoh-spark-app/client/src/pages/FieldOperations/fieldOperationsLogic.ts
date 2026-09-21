/* 现场交互层派生逻辑（纯函数，可单测）。
 *
 * 设计原则（对齐目标架构的"感知—理解—决策—授权—执行—反馈—学习"闭环）：
 *  1. 现场提醒**只能**由平台权威事实派生（派工 assignment + 执行回执 + 外骨骼
 *     会话）。不凭空产生"该去干活了"这类建议——没有事实就没有提醒。
 *  2. 每条提醒必须携带来源、依据时间与新鲜度，使人员能判断"这条还作数吗"。
 *     过期/缺失数据不得被渲染成确定的待办。
 *  3. 提醒是**建议与信息**，不是设备指令。本模块绝不产出任何关节/力矩/助力
 *     指令，也不产出绕过审批的派工。
 *  4. 覆盖状态显式区分：已派工未开工 / 进行中 / 已逾期未回执 / 回执缺失。
 */

export type FieldReminderSeverity = 'info' | 'attention' | 'overdue';
export type FieldReminderKind =
  | 'NO_SHIFT_ASSIGNMENT'
  | 'ASSIGNMENT_START_DUE'
  | 'ASSIGNMENT_OVERDUE'
  | 'STARTED_NEEDS_COMPLETION'
  | 'RECEIPT_DATA_STALE'
  | 'FIELD_DATA_NOT_READY'
  | 'EXO_SESSION_UNBOUND'
  | 'EXO_SESSION_STALE';

export interface FieldReminderSource {
  /** 事实来源（接口路径或表名），用于"这条从哪来"。 */
  origin: string;
  /** 依据事实的时间（ISO）。 */
  asOf: string | null;
  /** 依据是否新鲜；false 时 UI 必须降级呈现而不是当确定事实。 */
  fresh: boolean;
}

export interface FieldReminder {
  kind: FieldReminderKind;
  severity: FieldReminderSeverity;
  title: string;
  detail: string;
  /** 关联对象，便于一键跳转与追溯。 */
  assignmentId?: string;
  taskId?: string;
  planId?: string;
  sessionId?: string;
  source: FieldReminderSource;
}

/** 现场视角的执行记录（来自 GET /api/scheduler/executions）。 */
export interface FieldExecution {
  executionId: string;
  assignmentId: string;
  taskId: string;
  planId: string;
  status: string;
  personId?: string | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  source?: string | null;
}

export interface FieldExoSession {
  sessionId: string;
  exoId: string;
  personId: string;
  status: string;
  startedAt: string;
  expectedEndAt?: string | null;
  actualEndAt?: string | null;
}

export interface FieldReminderInput {
  /** 当前操作者对应的业务人员 ID（用于只显示"我的"任务）。 */
  personId: string | null;
  executions: FieldExecution[];
  exoSessions: FieldExoSession[];
  /** 判定新鲜度的当前时刻（注入以便确定性测试）。 */
  now: number;
  /**
   * 数据是否新鲜（来自 dataFreshness 判定）。
   * 只有请求成功且取得过数据后才进入新鲜度判定。
   */
  dataFresh: boolean;
  /**
   * 数据是否可用于判断（首次加载中或请求失败为 false）。
   * “未就绪/不可用”不得与“已过期”混为一谈。
   */
  dataAvailable?: boolean;
  /** 数据取得时刻（用于 source.asOf）。 */
  dataUpdatedAt: number;
  /** 现场数据视为陈旧的阈值（毫秒）。 */
  staleAfterMs?: number;
  /**
   * 外骨骼会话数据是否可用。
   *
   * `false`（请求失败/未取到）时**不得**产出 `EXO_SESSION_UNBOUND`：
   * 空数组既可能是"确实没有绑定"，也可能是"根本没读到"。把后者渲染成
   * "未绑定"就是拿缺失数据当结论。此时改由页面顶部告警说明"绑定状态未知"。
   */
  exoDataAvailable?: boolean;
}

export const DEFAULT_FIELD_STALE_MS = 5 * 60 * 1000;

/**
 * 事实来源标识（必须与页面实际调用的端点一致）。
 *
 * 现场执行数据走**按人收敛**的 `field/my-work`，不是全厂 `executions`——
 * 后者对 worker 角色是 403。来源标注写错会让现场人员以为数据来自另一个
 * 权限面，可信度判断随之失真。
 */
export const FIELD_EXECUTIONS_ORIGIN = 'GET /api/scheduler/field/my-work';
export const EXO_SESSIONS_ORIGIN = 'GET /api/exo/sessions';

/** 未终结的执行状态——只有这些才需要现场动作。 */
const OPEN_EXECUTION_STATUSES = new Set(['PLANNED', 'DISPATCHED', 'STARTED', 'PAUSED']);

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * 提醒文案里的时间一律渲染为北京时间（与全站时间展示口径一致）。
 *
 * 为什么：detail 里的时间不是给系统看的（逾期判定已用毫秒完成），是给现场人员
 * 看的。直接拼接 UTC ISO（如 2026-09-10T02:00:00.000Z）会让 UTC+8 的工人把
 * 02:00Z 读成"凌晨 2 点"，据此决定"该不该开工"必然出错。解析失败的输入原样
 * 返回（不编造一个看似正常的时间）。
 */
function formatBeijingTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/**
 * 派生现场提醒。
 *
 * 返回顺序即现场优先级：逾期 > 待开工 > 开工未完成 > 数据/绑定问题 > 信息。
 */
export function buildFieldReminders(input: FieldReminderInput): FieldReminder[] {
  const {
    personId, executions, exoSessions, now, dataFresh, dataUpdatedAt,
    staleAfterMs = DEFAULT_FIELD_STALE_MS,
    dataAvailable = true,
    exoDataAvailable = true,
  } = input;
  const reminders: FieldReminder[] = [];
  const dataAsOf = isoOrNull(new Date(dataUpdatedAt).toISOString());
  const baseSource = (origin: string): FieldReminderSource => ({
    origin, asOf: dataAsOf, fresh: dataFresh,
  });

  // 首次加载/请求失败不是"过期"。必须区分"还没拿到事实"与"拿到的结果已旧"，
  // 否则现场会在打开页面瞬间看到虚假的"数据已过期"结论。
  if (dataAvailable === false) {
    reminders.push({
      kind: 'FIELD_DATA_NOT_READY',
      severity: 'info',
      title: '现场数据尚未就绪，暂不给出现场结论',
      detail: '正在等待执行记录或上一次读取失败。系统不会把缺失数据当作已过期结论，也不会据此派生待办。',
      source: baseSource(FIELD_EXECUTIONS_ORIGIN),
    });
    return reminders;
  }

  // 新鲜度不足时，先给出**一条**显式的数据可信度提醒，并停止产出"待办类"提醒。
  // 理由：用过期数据渲染"你现在该做 X"正是本系统明令禁止的伪造确定性。
  if (!dataFresh) {
    reminders.push({
      kind: 'RECEIPT_DATA_STALE',
      severity: 'attention',
      title: '现场数据已过期，任务提醒已暂停',
      detail: `执行记录超过 ${Math.round(staleAfterMs / 1000)} 秒未更新，无法据此判断当前该做什么。请先刷新再行动。`,
      source: baseSource(FIELD_EXECUTIONS_ORIGIN),
    });
    return reminders;
  }

  const mine = personId
    ? executions.filter((e) => e.personId === personId && OPEN_EXECUTION_STATUSES.has(e.status))
    : [];

  if (personId && mine.length === 0) {
    reminders.push({
      kind: 'NO_SHIFT_ASSIGNMENT',
      severity: 'info',
      title: '当前没有分配给你的进行中任务',
      detail: '平台没有查到属于你的未终结派工。这不代表"无需工作"——若你已在现场作业，请确认派工是否已下发。',
      source: baseSource(FIELD_EXECUTIONS_ORIGIN),
    });
  }

  for (const execution of mine) {
    const plannedStart = isoOrNull(execution.plannedStartAt);
    const plannedStartMs = plannedStart ? Date.parse(plannedStart) : null;

    if (execution.status === 'PLANNED' || execution.status === 'DISPATCHED') {
      if (plannedStartMs != null && plannedStartMs < now) {
        const lateMin = Math.round((now - plannedStartMs) / 60000);
        reminders.push({
          kind: 'ASSIGNMENT_OVERDUE',
          severity: 'overdue',
          title: `任务 ${execution.taskId} 已超过计划开工 ${lateMin} 分钟`,
          detail: '尚未报告开工。请核对是否可以开始；若无法执行，请报告失败并说明原因。',
          assignmentId: execution.assignmentId,
          taskId: execution.taskId,
          planId: execution.planId,
          source: baseSource(FIELD_EXECUTIONS_ORIGIN),
        });
      } else {
        reminders.push({
          kind: 'ASSIGNMENT_START_DUE',
          severity: 'attention',
          title: `任务 ${execution.taskId} 等待开工`,
          detail: plannedStart ? `计划开始时间 ${formatBeijingTime(plannedStart)}。` : '计划开始时间未记录。',
          assignmentId: execution.assignmentId,
          taskId: execution.taskId,
          planId: execution.planId,
          source: baseSource(FIELD_EXECUTIONS_ORIGIN),
        });
      }
      continue;
    }

    if (execution.status === 'STARTED' || execution.status === 'PAUSED') {
      reminders.push({
        kind: 'STARTED_NEEDS_COMPLETION',
        severity: execution.status === 'PAUSED' ? 'attention' : 'info',
        title: `任务 ${execution.taskId} ${execution.status === 'PAUSED' ? '已暂停' : '进行中'}`,
        detail: '完成后请提交完工回执；未回执的记录不会进入偏差与学习统计。',
        assignmentId: execution.assignmentId,
        taskId: execution.taskId,
        planId: execution.planId,
        source: baseSource(FIELD_EXECUTIONS_ORIGIN),
      });
    }
  }

  // 外骨骼会话：绑定状态与新鲜度。会话缺失只提示"未绑定"，绝不断言设备故障——
  // 平台没有设备实时遥测时不得推断设备状态。
  // 会话数据不可用（exoDataAvailable=false）时整段跳过：读不到 ≠ 没绑定。
  if (personId && exoDataAvailable) {
    const active = exoSessions.filter((s) => s.personId === personId && s.status === 'active');
    if (active.length === 0) {
      reminders.push({
        kind: 'EXO_SESSION_UNBOUND',
        severity: 'info',
        title: '当前没有生效中的外骨骼绑定',
        detail: '未查到属于你的 active 外骨骼会话。若你正在穿戴设备，请由班组长确认绑定；绑定是显式且可审计的。',
        source: baseSource(EXO_SESSIONS_ORIGIN),
      });
    } else {
      for (const session of active) {
        const expected = isoOrNull(session.expectedEndAt);
        const expectedMs = expected ? Date.parse(expected) : null;
        if (expectedMs != null && expectedMs < now) {
          reminders.push({
            kind: 'EXO_SESSION_STALE',
            severity: 'attention',
            title: `外骨骼会话 ${session.exoId} 已超过预期结束时间`,
            detail: `预期结束 ${formatBeijingTime(expected)}。请确认是延长使用还是结束会话；过期的绑定不应继续代表当前状态。`,
            sessionId: session.sessionId,
            source: baseSource(EXO_SESSIONS_ORIGIN),
          });
        }
      }
    }
  }

  return reminders;
}

/**
 * 现场视角下的执行记录统计（用于"我这一班还剩多少"）。
 *
 * `now` 必须可注入：内部直接读 `Date.now()` 会让"逾期"计数随真实时间漂移，
 * 使测试依赖运行时刻（第一版正是如此，出现"同一用例隔一段时间就失败"）。
 * 时钟是外部输入，显式传入才可确定性地复现。
 */
export function summarizeFieldWork(
  executions: FieldExecution[],
  personId: string | null,
  now: number = Date.now(),
): {
  open: number;
  started: number;
  overdue: number;
  done: number;
} {
  const scoped = personId ? executions.filter((e) => e.personId === personId) : [];
  let open = 0;
  let started = 0;
  let done = 0;
  for (const e of scoped) {
    if (e.status === 'COMPLETED') { done += 1; continue; }
    if (e.status === 'STARTED' || e.status === 'PAUSED') { started += 1; continue; }
    if (OPEN_EXECUTION_STATUSES.has(e.status)) open += 1;
  }
  const overdue = scoped.filter((e) => {
    if (e.status !== 'PLANNED' && e.status !== 'DISPATCHED') return false;
    const planned = isoOrNull(e.plannedStartAt);
    return planned != null && Date.parse(planned) < now;
  }).length;
  return { open, started, overdue, done };
}
