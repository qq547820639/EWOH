/**
 * NO-36a：外骨骼会话是**执行边界**——派工/指派在**提交时刻**的守卫。
 *
 * 为什么需要这一层：
 * - 候选池/资格判定（NO-34a/35a）在**计划生成时**用世界模型快照判定"设备是否在
 *   会话中"，这是给人和求解器看的预检；
 * - 但方案从生成到审批再到下发之间存在时间窗（TOCTOU）：审批期间有人先戴上了那台
 *   外骨骼，或佩戴者换了人，下发时刻的物理事实已经变了。硬约束必须在**提交时刻**
 *   用权威事实再判一次，否则平台会把一个物理上不可能完成的指派写进任务
 *   （"看起来已派工"，现场却做不了——原则 7/8 都不允许）。
 *
 * 语义（与资格判定同一口径，`server/modules/scheduler/eligibility.service.ts`）：
 *   · 设备无活跃会话 → 无冲突；
 *   · 设备有活跃会话且指派人员 == 佩戴者 → 合法（人机同体，物理可行）；
 *   · 设备有活跃会话但指派给别人 → `wearer_mismatch`；
 *   · 设备有活跃会话而本指派没有人员 → `assignee_missing`（谁去用？不能猜）。
 *
 * 本模块是**纯函数**（无 IO/无框架依赖），IO 由 `ExoSessionService` 提供；
 * 这样同一口径可以被派工事务、任务创建、单测与 e2e 复用。
 */
import { normalizePersonRef } from '@shared/identity';

/** 待校验的指派（设备用调度主键 uuid；人员可为裸 uuid 或 `person:<uuid>`）。 */
export interface ExoAssignmentCandidate {
  /** 调度主键（`ewoh_device.id`，uuid）。 */
  deviceId: string;
  /** 被指派人员；缺省表示"未指定人"。 */
  personId?: string | null;
  /** 便于错误信息定位（assignmentId / taskId 等）。 */
  label?: string | null;
}

/** 活跃会话事实（`ExoSessionService` 读到的权威行）。 */
export interface ExoActiveSessionFact {
  sessionId: string;
  /** 业务设备号（`ewoh_device.device_id`），可能为空（数据缺口，不猜）。 */
  businessDeviceId: string | null;
  /** 设备调度主键（uuid）。 */
  deviceUuid: string;
  /** 会话里的佩戴者（`person:<uuid>` 规范身份，原样）。 */
  wearerPersonId: string;
}

export type ExoAssignmentConflictReason = 'wearer_mismatch' | 'assignee_missing';

export interface ExoAssignmentConflict {
  reason: ExoAssignmentConflictReason;
  deviceUuid: string;
  businessDeviceId: string | null;
  sessionId: string;
  /** 会话记录的佩戴者（规范身份原样）。 */
  wearerPersonId: string;
  /** 归一化后的佩戴者引用（裸 uuid）。 */
  wearerRef: string | null;
  assignedPersonId: string | null;
  assignedRef: string | null;
  label: string | null;
}

/**
 * 找出与"佩戴中"事实冲突的指派。
 *
 * 同一设备只可能有 ≤1 条活跃会话（DB 部分唯一索引 + 服务层双保险），
 * 因此按 deviceUuid 建索引即可；会话事实缺失的设备**不会**被误判为冲突
 * （缺数据 ≠ 有冲突，也不阻塞——与资格判定同口径）。
 */
export function findExoAssignmentConflicts(
  assignments: readonly ExoAssignmentCandidate[],
  activeSessions: readonly ExoActiveSessionFact[],
): ExoAssignmentConflict[] {
  if (assignments.length === 0 || activeSessions.length === 0) return [];
  const byDevice = new Map<string, ExoActiveSessionFact>();
  for (const fact of activeSessions) {
    if (fact?.deviceUuid) byDevice.set(String(fact.deviceUuid), fact);
  }
  const conflicts: ExoAssignmentConflict[] = [];
  for (const assignment of assignments) {
    const deviceUuid = String(assignment?.deviceId ?? '').trim();
    if (!deviceUuid) continue;
    const fact = byDevice.get(deviceUuid);
    if (!fact) continue;
    const wearerRef = normalizePersonRef(fact.wearerPersonId);
    const assignedRef = normalizePersonRef(assignment.personId ?? null);
    let reason: ExoAssignmentConflictReason | null = null;
    if (assignedRef === null) {
      reason = 'assignee_missing';
    } else if (wearerRef === null || assignedRef !== wearerRef) {
      // 佩戴者引用不可解析（数据缺口）时 fail-closed：不能证明"就是他"，就不能下发。
      reason = 'wearer_mismatch';
    }
    if (!reason) continue;
    conflicts.push({
      reason,
      deviceUuid,
      businessDeviceId: fact.businessDeviceId ?? null,
      sessionId: fact.sessionId,
      wearerPersonId: fact.wearerPersonId,
      wearerRef,
      assignedPersonId: assignment.personId ?? null,
      assignedRef,
      label: assignment.label ?? null,
    });
  }
  return conflicts;
}

/** 冲突的事实摘要（错误信息/审计共用；不隐藏设备号缺口）。 */
export function describeExoAssignmentConflict(conflict: ExoAssignmentConflict): string {
  const device = conflict.businessDeviceId
    ? `设备 ${conflict.businessDeviceId}`
    : `设备 ${conflict.deviceUuid}（业务设备号未记录）`;
  const wearer = conflict.wearerRef ?? `无法解析（原值 ${conflict.wearerPersonId}）`;
  const assigned = conflict.assignedRef ?? '未指派人员';
  const detail =
    conflict.reason === 'assignee_missing'
      ? `本指派没有指定人员，但该设备正由 ${wearer} 佩戴`
      : `被指派人员 ${assigned} ≠ 佩戴者 ${wearer}`;
  return `${device} 处于外骨骼会话 ${conflict.sessionId}（佩戴者 ${wearer}）：${detail}；`
    + '一台外骨骼同一时刻只能由佩戴它的人使用，请结束会话、改派佩戴者或更换设备';
}

/**
 * 从世界模型快照设备项提取活跃会话事实（派工事务使用的适配器）。
 *
 * 为什么派工走快照而不是直读会话表：派工本来就必须读当前世界状态
 * （安全阻断/工位容量/新鲜度），会话事实是其中一项；共用同一次 `collectState`
 * 既省一次往返，也保证"候选池看到的佩戴约束"与"提交时刻复查的佩戴约束"
 * 来自同一份世界模型（原则 3）。规则本身仍是 `findExoAssignmentConflicts`
 * 单点实现——两条路径只是事实适配器不同。
 */
export function activeSessionFactsFromDevices(
  devices: readonly {
    id?: string | null;
    deviceId?: string | null;
    activeExoSession?: { sessionId?: string | null; personId?: string | null } | null;
  }[],
): ExoActiveSessionFact[] {
  const facts: ExoActiveSessionFact[] = [];
  for (const device of devices ?? []) {
    const session = device?.activeExoSession;
    if (!session) continue;
    const deviceUuid = String(device?.id ?? '').trim();
    const sessionId = String(session.sessionId ?? '').trim();
    const wearerPersonId = String(session.personId ?? '').trim();
    if (!deviceUuid || !sessionId || !wearerPersonId) continue; // 形状不全 → 不猜，也不据此封锁
    facts.push({
      deviceUuid,
      businessDeviceId: device?.deviceId ?? null,
      sessionId,
      wearerPersonId,
    });
  }
  return facts;
}

/* ------------------------------------------------------------------ */
/* NO-39a：反方向的执行边界——开始会话时的"在飞任务"检查                */
/* ------------------------------------------------------------------ */

/**
 * 在飞任务指派（已下发/已接收/执行中等）。
 *
 * 与 NO-36a 的**方向相反、事实同源**：
 *   · 派工时查"设备是否正被别人佩戴"（会话 → 指派）；
 *   · 开始会话时查"设备是否已被指派给别人"（指派 → 会话）。
 * 两侧都成立，才谈得上"这台外骨骼此刻归谁用"是唯一确定的。
 *
 * 只收 `TASK_LOCKED_STATUSES`（dispatched/received/executing/paused/exception）：
 * 未下发的任务（draft/pending_*）**不是执行边界**——那只是方案/待批（原则 6），
 * 不能在现场先把设备戴走时反过来卡住合法的会话开始；等它们真被下发时，
 * 派工侧的事务内复查会看到会话并拒绝（NO-36a）。
 */
export interface InFlightTaskAssignment {
  taskId: string;
  title: string | null;
  status: string;
  /** 设备调度主键（uuid）。 */
  deviceUuid: string;
  assigneeId: string | null;
}

export type ExoSessionStartConflictReason = 'assignee_mismatch' | 'assignee_missing';

export interface ExoSessionStartConflict {
  reason: ExoSessionStartConflictReason;
  taskId: string;
  title: string | null;
  status: string;
  deviceUuid: string;
  assigneePersonId: string | null;
  assigneeRef: string | null;
  wearerPersonId: string;
  wearerRef: string | null;
}

/**
 * 找出"与本次会话开始冲突的在飞任务"。
 *
 * 语义与派工侧完全对称：
 *   · 在飞任务的受派人 == 佩戴者 → 合法（人机同体，同一个人）；
 *   · 受派人 ≠ 佩戴者 → `assignee_mismatch`；
 *   · 在飞任务没写受派人 → `assignee_missing`（谁去用？不能猜）。
 */
export function findExoSessionStartConflicts(
  inFlightTasks: readonly InFlightTaskAssignment[],
  params: { deviceUuid: string; wearerPersonId: string },
): ExoSessionStartConflict[] {
  const deviceUuid = String(params?.deviceUuid ?? '').trim();
  if (!deviceUuid) return [];
  const wearerRef = normalizePersonRef(params?.wearerPersonId ?? null);
  const conflicts: ExoSessionStartConflict[] = [];
  for (const task of inFlightTasks ?? []) {
    if (String(task?.deviceUuid ?? '').trim() !== deviceUuid) continue;
    const assigneeRef = normalizePersonRef(task.assigneeId ?? null);
    let reason: ExoSessionStartConflictReason | null = null;
    if (assigneeRef === null) reason = 'assignee_missing';
    else if (wearerRef === null || assigneeRef !== wearerRef) reason = 'assignee_mismatch';
    if (!reason) continue;
    conflicts.push({
      reason,
      taskId: task.taskId,
      title: task.title ?? null,
      status: task.status,
      deviceUuid,
      assigneePersonId: task.assigneeId ?? null,
      assigneeRef,
      wearerPersonId: params.wearerPersonId,
      wearerRef,
    });
  }
  return conflicts;
}

/** 会话开始冲突的事实摘要（错误信息/审计共用）。 */
export function describeExoSessionStartConflict(conflict: ExoSessionStartConflict): string {
  const assignee = conflict.assigneeRef ?? '未指派人员';
  const wearer = conflict.wearerRef ?? `无法解析（原值 ${conflict.wearerPersonId}）`;
  const task = conflict.title ? `任务「${conflict.title}」（${conflict.taskId}）` : `任务 ${conflict.taskId}`;
  const detail =
    conflict.reason === 'assignee_missing'
      ? `${task} 已处于 ${conflict.status} 且没有指定执行人`
      : `${task} 已处于 ${conflict.status} 并指派给 ${assignee}`;
  return `${detail}，而本次会话的佩戴者是 ${wearer}：这台外骨骼此刻已经被这张任务占用于他人作业；`
    + '请先把该任务改派给佩戴者、回退/取消该任务，或换一台设备再开始会话';
}

/* ------------------------------------------------------------------ */
/* NO-40a：会话开始的设备上下文（页面用它决定"绑定哪张任务"）           */
/* ------------------------------------------------------------------ */

export interface DeviceContextTaskFact {
  taskId: string;
  title: string | null;
  status: string;
  assigneeId: string | null;
  /** 任务计划结束时间（ISO）；缺失 → null（不继承、也不猜）。 */
  planEnd: string | null;
}

export interface DeviceContextSuggestion {
  taskId: string | null;
  expectedEndAt: string | null;
  /** 该任务的受派人是否就是本次要开始会话的人员（人机同体 = 不会被边界拒绝）。 */
  assigneeMatches: boolean;
  /** 面向现场的一句话理由（含"为什么不建议/不给建议"）。 */
  reason: string;
}

/**
 * 由"该设备的在飞任务"推出建议绑定（纯函数）。
 *
 * 语义（原则 5/6/10：只给能执行的建议，且说清依据）：
 *   · 无在飞任务 → 不绑定（没有依据把这次佩戴记到某张任务上）；
 *   · 恰有一张 → 绑定它；受派人 == 本次人员 → 标记匹配；计划结束时间晚于现在 → 一并继承；
 *   · 多张 → **不给建议**（选择是人的决定，不替现场猜），理由写明数量；
 *   · 传入的人员与受派人不一致时仍给出建议，但 `assigneeMatches=false` + 理由说明
 *     开始会话会被执行边界拒绝（现场应改派或换人，而不是让平台放行）。
 */
export function buildDeviceContextSuggestion(
  inFlightTasks: readonly DeviceContextTaskFact[],
  options: { nowMs?: number; personId?: string | null } = {},
): DeviceContextSuggestion {
  const tasks = Array.isArray(inFlightTasks) ? inFlightTasks : [];
  if (tasks.length === 0) {
    return {
      taskId: null,
      expectedEndAt: null,
      assigneeMatches: false,
      reason: '该设备当前没有在飞任务：本次佩戴不绑定任务（也不会继承计划结束时间）',
    };
  }
  if (tasks.length > 1) {
    return {
      taskId: null,
      expectedEndAt: null,
      assigneeMatches: false,
      reason: `该设备存在 ${tasks.length} 张在飞任务：请先收口或指定其一，平台不替现场选择绑定哪张`,
    };
  }
  const task = tasks[0];
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const planEndMs = task.planEnd ? Date.parse(task.planEnd) : Number.NaN;
  const inheritable = Number.isFinite(planEndMs) && planEndMs > nowMs;
  const wearerRef = normalizePersonRef(options.personId ?? null);
  const assigneeRef = normalizePersonRef(task.assigneeId ?? null);
  const assigneeMatches = wearerRef !== null && assigneeRef !== null && wearerRef === assigneeRef;
  const parts = [
    `唯一在飞任务：${task.title ?? task.taskId}（${task.status}）`,
    assigneeMatches
      ? '受派人就是本次佩戴人员（人机同体，可开始会话）'
      : assigneeRef
        ? `受派人是 ${assigneeRef}，与本次佩戴人员不一致：开始会话会被执行边界拒绝（请改派或换人）`
        : '该任务没有指定受派人：开始会话会被执行边界拒绝（请先指派给佩戴者）',
  ];
  if (inheritable && task.planEnd) {
    parts.push(`可继承任务计划结束时间 ${task.planEnd} 作为预计结束（提升偏差可比性）`);
  } else if (task.planEnd) {
    parts.push(`任务计划结束时间 ${task.planEnd} 已过期，不继承（请现场填写或调整计划）`);
  } else {
    parts.push('该任务没有计划结束时间：预计结束时间未记录');
  }
  return {
    taskId: task.taskId,
    expectedEndAt: inheritable && task.planEnd ? task.planEnd : null,
    assigneeMatches,
    reason: parts.join('；'),
  };
}
