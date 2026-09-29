/**
 * SchedulerService Strangler Refactor（Task 2）：facade 与各职责服务共享的
 * 纯函数助手（无状态、无 DB 依赖）。被 scheduler.service.ts 降级后的 facade
 * 及其 7 个拆分服务共同引用，避免在各服务间复制粘贴。
 *
 * - toOrgContext：actor（请求上下文）→ 归一化 OrgContext（与写路径 GUC 语义一致）；
 * - mapPlan / mapAudit：legacy 表行 → API 形状映射（confirm/reject/query 共用）。
 */
import {
  ewohSchedulePlan,
  ewohScheduleAudit,
} from '@server/database/schema';
import type {
  SchedulePlan,
  ScheduleAudit,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';

export function toOrgContext(actor?: OrgContext): OrgContext {
  return {
    userId: actor?.userId ?? 'system',
    primaryOrgId: actor?.primaryOrgId ?? '',
    role: actor?.role,
    // RCPTCTX-01（V265）：`roles`（JWT 角色集）与 `personId`（账号↔人员绑定）此前在这一步被丢掉，
    // 于是 POST /api/scheduler/feedback/actuals 这条回执腿读不到任何特权角色、也读不到绑定人员，
    // 除 global_admin 外一律 ACTUALS_ADVANCEMENT_FORBIDDEN —— 而同一谓词的姊妹腿
    // （POST /api/scheduler/executions/:assignmentId/update）原样透传 ctx，同一账号可通行。
    // 这两个字段只进料"谁能推进回执"的判定，不进 buildGucSettings（那里只用 userId/orgIds/isGlobalAdmin），
    // 因此转发它们不改变 GUC 与行级可见性。
    roles: actor?.roles,
    personId: actor?.personId,
    accessibleOrgIds:
      actor?.accessibleOrgIds ??
      (actor?.primaryOrgId ? [actor.primaryOrgId] : []),
    isGlobalAdmin: actor?.isGlobalAdmin ?? false,
  };
}

export function mapPlan(r: typeof ewohSchedulePlan.$inferSelect): SchedulePlan {
  return {
    id: r.id,
    planId: r.planId,
    planName: r.planName,
    strategy: r.strategy,
    status: r.status ?? 'shadow',
    taktImprovement: r.taktImprovement ?? 0,
    highLoadPersons: r.highLoadPersons ?? 0,
    lowBatteryRisk: r.lowBatteryRisk ?? 0,
    affectedPersons: r.affectedPersons ?? 0,
    metricsJson: (r.metricsJson as Record<string, unknown> | null) ?? null,
    reason: r.reason ?? null,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    confirmedBy: r.confirmedBy ?? null,
    confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
    confirmReason: r.confirmReason ?? null,
  };
}

export function mapAudit(r: typeof ewohScheduleAudit.$inferSelect): ScheduleAudit {
  return {
    id: r.id,
    auditId: r.auditId,
    planId: r.planId,
    action: r.action,
    operator: r.operator ?? null,
    reason: r.reason ?? null,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
  };
}
