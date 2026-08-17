/**
 * Plan 行组织可见性守卫（ADR-071，NO-13v，§15/§31）。
 *
 * 单一实现：所有 ewoh_schedule_plan 读/变面的应用层 org 守卫共用本模块，
 * 禁止在调用点内联重复判断（§31）。
 *
 * 语义与 standalone_025 RLS policy 逐字对齐（分层等价，不发明第二套）：
 *   - actor 缺失（内部可信流）→ 放行（DB 层 RLS 继续兜底）；
 *   - planOrgId == null（NULL=全局/存量行，standalone_025 过渡边界）→ 放行；
 *   - planOrgId === actor.primaryOrgId → 放行；
 *   - 其余 → NotFoundException（与"方案不存在"同语义，反枚举，不泄露存在性）。
 */
import { NotFoundException } from '@nestjs/common';
import { or, isNull, eq, type SQL } from 'drizzle-orm';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 行级组织可见性守卫（ADR-071/072，§15/§31 单一实现）：
 * run/plan/constraint/audit 读面的应用层 org 守卫共用本函数，
 * 禁止在调用点内联重复判断。
 *
 * 语义与 standalone_025 RLS policy 逐字对齐（分层等价，不发明第二套）：
 *   - actor 缺失（内部可信流）→ 放行（DB 层 RLS 继续兜底）；
 *   - orgId == null（NULL=全局/存量行，standalone_025 过渡边界）→ 放行；
 *   - orgId === actor.primaryOrgId → 放行；
 *   - 其余 → NotFoundException（与"对象不存在"同语义，反枚举，不泄露存在性）。
 *
 * R2-SMI-011：actor.isGlobalAdmin → 放行——global_admin 的单条读与其列表
 * 全量行为对齐（此前列表可见、详情 404 的功能性不一致）。
 */
export function assertTenantVisible(
  orgId: string | null | undefined,
  actor: OrgContext | null | undefined,
  subjectLabel?: string,
): void {
  if (!actor) return;
  if (actor.isGlobalAdmin) return;
  if (orgId == null) return;
  if (orgId !== actor.primaryOrgId) {
    throw new NotFoundException(`${subjectLabel ?? '(unknown)'} not found`);
  }
}

/**
 * ADR-071 别名（方案行语义不变；R-92 调用点保持）。
 */
export function assertPlanTenantVisible(
  planOrgId: string | null | undefined,
  actor: OrgContext | null | undefined,
  planId?: string,
): void {
  assertTenantVisible(planOrgId, actor, planId ? `Plan ${planId}` : undefined);
}

/**
 * 读面 SQL 组织条件（ADR-071 决策 2）：actor 存在时
 * `org_id IS NULL OR org_id = primaryOrgId`——与 RLS USING 分支等价。
 * actor 缺失返回 undefined（内部可信流，RLS 兜底）。
 */
export function buildPlanOrgCondition(
  orgIdColumn: unknown,
  actor: OrgContext | null | undefined,
): SQL | undefined {
  if (!actor) return undefined;
  // drizzle 列类型是内部类型；调用方传入 ewohSchedulePlan.orgId（真实列）。
  return or(isNull(orgIdColumn as never), eq(orgIdColumn as never, actor.primaryOrgId));
}
