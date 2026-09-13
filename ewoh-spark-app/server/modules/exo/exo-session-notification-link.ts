/**
 * exo-session-notification-link.ts — 外骨骼会话的"处置 → 提醒终态"（NO-44a）。
 *
 * 机制已收敛到通用实现 `notification-resolution.link.ts`（NO-45a 推广到审批到期提醒），
 * 这里只保留外骨骼会话的**词表与范围**：通知号前缀 `NTF-EXO-`（NO-37a 的确定性规则）。
 *
 * 留这一层的原因：调用点（ExoSessionService）不该知道通知号的构造规则，
 * 规则变化（例如未来加桶）时只改这里；同时保持既有测试与导出名不变。
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { NotificationResolution } from '@shared/notification-resolution';
import {
  resolveNotificationsFor,
  type NotificationResolutionResult,
} from '../notification/notification-resolution.link';

/** 只处置外骨骼提醒：通知号由 NO-37a 的确定性规则生成（`NTF-EXO-` 前缀）。 */
export const EXO_NOTIFICATION_PREFIX = 'NTF-EXO-';

export type SessionNotificationResolution = NotificationResolutionResult;

export interface ResolveSessionNotificationsInput {
  orgId: string;
  sessionId: string;
  resolution: NotificationResolution;
  /** 处置人（会话的 endedBy / 操作者）。必填：无人的处置不落痕。 */
  resolvedBy: string;
  /** 处置引用：更正=新会话号；收工/中止=会话号本身。 */
  resolutionRef: string;
  now?: Date;
}

/** 在调用方的事务里把该会话的提醒落到处置终态（幂等、三重限定）。 */
export async function resolveSessionNotifications(
  executor: Pick<PostgresJsDatabase, 'update'>,
  input: ResolveSessionNotificationsInput,
): Promise<SessionNotificationResolution> {
  return resolveNotificationsFor(executor, {
    orgId: input.orgId,
    externalRef: input.sessionId,
    notificationIdPrefix: EXO_NOTIFICATION_PREFIX,
    resolution: input.resolution,
    resolvedBy: input.resolvedBy,
    resolutionRef: input.resolutionRef,
    ...(input.now ? { now: input.now } : {}),
  });
}
