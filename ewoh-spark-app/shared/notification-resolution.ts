/**
 * notification-resolution.ts — 通知"处置结果"的封闭词表（NO-44a）。
 *
 * 为什么需要第二个终态维度：
 *   · `read`（已读）表达的是"人看过了"，它**不能**表达"这件事已经按某次处置了结"；
 *   · 反过来，如果处置后把提醒直接删掉或改成已读，事后就无法回答
 *     "这条提醒最后是怎么了结的、谁了结的、依据哪次处置"（原则 8 审计基线）。
 *
 * 因此平台保留两件事，互不替代：
 *   1. 通知行本身（标题/正文/收件人/渠道/时间）；
 *   2. `resolution` + `resolvedAt` + `resolvedBy` + `resolutionRef` 四个字段，
 *      指向**主事实的那次处置**（会话收工/中止/按实际佩戴人更正）。
 *
 * 词表封闭：未登记的值一律当作"未知处置"，页面原样透出、不翻译成已知结论（原则 7）。
 */

/**
 * 处置码（封闭词表，按**主事实类型**命名空间化）。
 *
 * 每个码回答同一个问题："这条提醒是因为**哪次处置**才不需要人再处理的？"——
 * 因此码里必须能看出主事实与处置性质，而不是笼统的 `handled`。
 */
export const NOTIFICATION_RESOLUTIONS = [
  /** 外骨骼会话正常收工 → 该会话的提醒不再需要人处理。 */
  'session_ended',
  /** 外骨骼会话被中止（异常/提前终止）→ 同样了结，但语义是"非正常结束"。 */
  'session_aborted',
  /** 外骨骼会话按实际佩戴人更正（交接）→ 旧会话的提醒了结，`resolutionRef` 指向新会话。 */
  'session_corrected',
  /**
   * 执行边界授权**已失效** → "即将失效，请尽快处理"这条催促的前提消失了
   * （仍然保留"已失效"桶的待办：那是需要人重新申请的事实）。
   */
  'approval_expired',
  /**
   * 同一对象有了**新的已通过审批**（重新申请成功）→ 旧审批的到期提醒了结，
   * `resolutionRef` 指向新的审批号。
   */
  'approval_superseded',
  /**
   * 安灯被**关闭**（处置终态）→ 开灯/SLA 升级提醒了结。
   * 注意：`acknowledged`/`processing` 都**不**关闭提醒——那时告警仍然有效。
   */
  'andon_cleared',
  /** Agent 待批命令已被人处理（批准/驳回）→ 待审批提醒了结。 */
  'agent_approval_decided',
  /** Agent 待批命令超时作废（24h TTL）→ 待审批提醒了结（超时是显式状态，不静默消失）。 */
  'agent_approval_expired',
  /** 数据质量告警经人核实：**数据可信**（可用于决策）→ 提醒了结。 */
  'data_quality_confirmed',
  /** 数据质量告警经人核实：**数据不可信**（相关决策需复核）→ 提醒同样了结（已裁决）。 */
  'data_quality_contested',
  /** 改进行动项已按验收判据完成（含结果说明）→ 逾期提醒了结。 */
  'action_completed',
  /** 改进行动项被放弃/拒绝（理由必填）→ 逾期提醒了结（不是"做完了"，但确实了结了）。 */
  'action_dropped',
] as const;

export type NotificationResolution = (typeof NOTIFICATION_RESOLUTIONS)[number];

const RESOLUTION_LABELS: Record<NotificationResolution, string> = {
  session_ended: '已随会话收工关闭',
  session_aborted: '已随会话中止关闭',
  session_corrected: '已随佩戴人更正关闭（交接）',
  approval_expired: '已随授权失效关闭（催促前提已消失）',
  approval_superseded: '已随新审批通过关闭（重新申请成功）',
  andon_cleared: '已随安灯关闭结束',
  agent_approval_decided: '已随 Agent 待批命令处置结束',
  agent_approval_expired: '已随 Agent 待批命令超时作废',
  data_quality_confirmed: '已核实：数据可信（可用于决策）',
  data_quality_contested: '已核实：数据不可信（相关决策需复核）',
  action_completed: '已按验收判据完成（含结果说明）',
  action_dropped: '已放弃/拒绝（理由已记录）',
};

/** 已登记处置的中文文案；未登记/为空 → null（调用方如实展示原值，不猜）。 */
export function notificationResolutionLabel(resolution: string | null | undefined): string | null {
  const key = String(resolution ?? '').trim();
  if (key === '') return null;
  return RESOLUTION_LABELS[key as NotificationResolution] ?? null;
}

export function isNotificationResolution(value: unknown): value is NotificationResolution {
  return typeof value === 'string' && (NOTIFICATION_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * 通知 status 的封闭取值集合。
 *
 * 注意 `resolved`（已处置）与 `sent`/`failed`（推送投递）是三件不同的事：
 * 前者是业务处置终态，后者是投递事实——过滤器只暴露前三个（业务视角），
 * 投递状态由通知中心按渠道分组展示。
 */
export const NOTIFICATION_STATUSES = ['pending', 'read', 'resolved', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** 列表接口允许的 `status` 过滤值（留空 = 全部）。 */
export const NOTIFICATION_LIST_FILTERS = ['pending', 'read', 'resolved'] as const;
export type NotificationListFilter = (typeof NOTIFICATION_LIST_FILTERS)[number];

export function isNotificationListFilter(value: unknown): value is NotificationListFilter {
  return typeof value === 'string' && (NOTIFICATION_LIST_FILTERS as readonly string[]).includes(value);
}
