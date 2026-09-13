/**
 * notification-resolution.link.ts — 通用"提醒 → 处置 → 终态"链接（NO-45a）。
 *
 * 这是 NO-44a 的推广：处置即闭环这件事对**每一类派生提醒**都成立，只是
 * "主事实是谁、处置叫什么"不同。把机制收敛到一个函数，避免每个模块各写一套
 * （外骨骼会话、执行边界授权到期都用它）。
 *
 * 三条诚实边界（与 NO-44a 一致，且对所有提醒源统一生效）：
 *   1. **只动本主事实的提醒**：租户 + `external_ref` + 通知号前缀三重限定；
 *   2. **已读不是待处置**：`pending` 行 → `resolved`；`read` 行状态不动，只补写处置四列；
 *   3. **投递故障不归处置管**：`sent`/`failed` 是推送投递事实，一律不碰
 *      （否则"投递失败"会被业务动作悄悄吞掉）。
 *
 * 幂等：两个 UPDATE 都带 `resolution IS NULL`；重复处置返回 `{closed:0, annotated:0}`，
 * **不覆盖第一次的处置依据**（第一次了结它的那次处置才是审计要的答案）。
 */
import { and, eq, isNull, like } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ewohNotification } from '@server/database/schema';
import type { NotificationResolution } from '@shared/notification-resolution';

export interface NotificationResolutionResult {
  /** pending → resolved 的条数（"随处置关闭了几条待办"）。 */
  closed: number;
  /** 已读行补充处置痕迹的条数（状态不变，仅补审计信息）。 */
  annotated: number;
  /** 本次真正改动的通知号（供事件证据与排障）。 */
  notificationIds: string[];
}

export interface ResolveNotificationsInput {
  orgId: string;
  /** 主事实引用（外骨骼=会话号；授权到期=审批号）。 */
  externalRef: string;
  /** 通知号前缀（含主事实标识），用于把范围钉死到"这条主事实的这一类提醒"。 */
  notificationIdPrefix: string;
  resolution: NotificationResolution;
  /** 处置人（会话 endedBy / 审批操作者 / `system:<job>`）。必填：无人的处置不落痕。 */
  resolvedBy: string;
  /** 处置引用（更正是新会话号；被新审批取代是新审批号；无则填主事实引用）。 */
  resolutionRef: string;
  now?: Date;
}

/**
 * SQL LIKE 模式转义。
 *
 * 为什么必须转义：通知号前缀里可能带 `_`（单字符通配）或 `%`（多字符通配），
 * 直接拼接会让"只关本主事实的提醒"变成"关掉一批看起来像的提醒"。
 * PostgreSQL 的 LIKE 默认转义符是反斜杠，因此 `\_` / `\%` / `\\` 即字面量。
 */
export function escapeLikePattern(value: string): string {
  return String(value ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 在**调用方的事务里**把某条主事实的提醒落到处置终态。
 *
 * 为什么必须在同一事务：主事实的处置与"提醒关闭"是同一件事的两面——
 * 分开提交会出现"事已办完提醒还挂着"（现场继续被噪音打扰）或
 * "提醒关了但事没办"（提醒凭空消失）两种半成品。
 */
export async function resolveNotificationsFor(
  executor: Pick<PostgresJsDatabase, 'update'>,
  input: ResolveNotificationsInput,
): Promise<NotificationResolutionResult> {
  const orgId = String(input.orgId ?? '').trim();
  const externalRef = String(input.externalRef ?? '').trim();
  const prefix = String(input.notificationIdPrefix ?? '').trim();
  const resolvedBy = String(input.resolvedBy ?? '').trim();
  const now = input.now ?? new Date();
  const resolutionRef = String(input.resolutionRef ?? '').trim() || externalRef;
  // 缺失上下文 → 不猜、不动数据（fail-closed：宁可不关，也不误关别人的提醒）。
  if (orgId === '' || externalRef === '' || prefix === '' || resolvedBy === '') {
    return { closed: 0, annotated: 0, notificationIds: [] };
  }

  const scope = and(
    eq(ewohNotification.orgId, orgId),
    eq(ewohNotification.externalRef, externalRef),
    like(ewohNotification.notificationId, `${escapeLikePattern(prefix)}%`),
    isNull(ewohNotification.resolution),
  );
  const stamp = {
    resolution: input.resolution,
    resolvedAt: now,
    resolvedBy,
    resolutionRef,
    updatedAt: now,
  };

  const closedRows = await executor
    .update(ewohNotification)
    .set({ ...stamp, status: 'resolved' })
    .where(and(scope, eq(ewohNotification.status, 'pending')))
    .returning({ notificationId: ewohNotification.notificationId });

  const annotatedRows = await executor
    .update(ewohNotification)
    .set(stamp)
    .where(and(scope, eq(ewohNotification.status, 'read')))
    .returning({ notificationId: ewohNotification.notificationId });

  const ids = [...closedRows, ...annotatedRows]
    .map((row) => String((row as { notificationId?: unknown }).notificationId ?? ''))
    .filter((id) => id !== '');
  return {
    closed: closedRows.length,
    annotated: annotatedRows.length,
    notificationIds: ids,
  };
}
