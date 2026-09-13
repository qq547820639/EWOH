import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte } from 'drizzle-orm';
import { ewohEvent } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';
import { alertActionToState, alertStateTransitionAllowed, alertTransitionEdgeExists } from '@shared/alert-state-machine';

/**
 * ADR-031：alert/andon 处置状态机收敛到 shared/alert-state-machine
 * （alert.yaml 单一事实源 + 门禁交叉核对）；保留函数名兼容既有调用方。
 */
export function nextAlertStatus(
  current: string,
  action: string,
  actorRole?: string,
): string | null {
  const target = alertActionToState(action);
  if (!target) return null;
  return alertStateTransitionAllowed(current, target.to, actorRole)
    ? target.to
    : null;
}

/**
 * NEST-409/410：AccessTokenGuard 只挂 roles 数组（无单值 role），角色判定
 * 改为遍历 actor.roles——任一角色满足转移即放行。
 * SH-004 联动（W6 终态）：roles 为空时不再回退 [undefined] 缺省放行——
 * roleSatisfies 已收敛 fail-closed，无角色信息一律拒绝（spec MODIFIED
 * 「状态机转移校验」：调用方强制传服务端角色）。
 */
function nextAlertStatusForActor(
  current: string,
  action: string,
  actor?: OrgContext,
): string | null {
  const target = alertActionToState(action);
  if (!target) return null;
  // ADR-031 / SH-004 配套修复：global_admin 作为超级管理员放行所有告警处置
  // 转移（确认/处置/关闭/重开）。与 model/task 状态机的 isGlobalAdmin override 一致，
  // 否则纯 global_admin 账号（如演示 admin）因不含 handler 角色被 fail-closed 拒绝，
  // 导致风险告警页「确认」按钮必报 400「Transition ... not allowed」。
  // ⚠️ 豁免的是**角色条件**而不是**转移拓扑**（2026-09-13 对抗审查补口）：此前直接
  // `return target.to` 连 alert.yaml 里不存在的边（open→closed、open→reopened…）
  // 一并放行——确认/处置两步审计被整段跳过，"非法转移被拒"契约失效。因此超管
  // 分支先用 alertTransitionEdgeExists 验拓扑（边必须真实存在），再免角色。
  if (actor?.isGlobalAdmin) {
    return alertTransitionEdgeExists(current, target.to) ? target.to : null;
  }
  const roles = actor?.roles ?? [];
  for (const role of roles) {
    if (alertStateTransitionAllowed(current, target.to, role)) {
      return target.to;
    }
  }
  return null;
}

@Injectable()
export class AlertService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /**
   * NEST-433：列表 org 过滤（global_admin 放行；org 缺失 401）。
   * R2-SMI-007：补分页纪律——limit 默认 100、上限 500（global_admin 全租户
   * 分支同样受限），ewoh_event 高写入量表不再被单请求全量拉取。
   */
  async listAlerts(
    actor?: OrgContext,
    options?: { limit?: number; since?: string; hours?: number },
  ) {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：alert 列表必须带租户上下文',
      );
    }
    const limit = Math.min(
      Math.max(Number(options?.limit) || 100, 1),
      500,
    );
    // 时间窗滚动查询（2026-08-19，与 dashboard/events 同语义）：默认 24h
    // （since 显式传入时以其为准）；clamp [1,168]。事件表高写入量，无窗
    // 全表扫描在峰值时拖垮平台。
    const safeHours = Math.min(
      Math.max(
        options?.hours != null && Number.isFinite(options.hours)
          ? Math.trunc(options.hours)
          : 24,
        1,
      ),
      168,
    );
    const sinceDate =
      options?.since && !Number.isNaN(Date.parse(options.since))
        ? new Date(options.since)
        : new Date(Date.now() - safeHours * 3_600_000);
    const sinceFilter = [gte(ewohEvent.createdAt, sinceDate)];
    if (actor?.isGlobalAdmin) {
      return this.db
        .select()
        .from(ewohEvent)
        .where(and(...sinceFilter))
        .orderBy(desc(ewohEvent.createdAt))
        .limit(limit);
    }
    return this.db
      .select()
      .from(ewohEvent)
      .where(and(eq(ewohEvent.orgId, orgId), ...sinceFilter))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(limit);
  }

  /** NEST-433：单条读 org 守卫（NULL legacy 行放行，跨租户 404）。 */
  async getAlert(eventId: string, actor?: OrgContext) {
    const [row] = await this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventId, eventId));
    if (!row) {
      throw new NotFoundException(`Alert ${eventId} not found`);
    }
    assertTenantVisible(row.orgId, actor, `Alert ${eventId}`);
    return row;
  }

  async transitionAlert(eventId: string, action: string, actor?: OrgContext) {
    const alert = await this.getAlert(eventId, actor);
    const currentStatus = alert.status ?? 'open';
    // NEST-409/410：actor.roles 派生（修复 safety_admin reopen 失效）。
    const status = nextAlertStatusForActor(currentStatus, action, actor);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${alert.status}`,
      );
    }
    const [row] = await this.db
      .update(ewohEvent)
      .set({ status })
      .where(
        and(
          eq(ewohEvent.eventId, eventId),
          eq(ewohEvent.status, currentStatus),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `alert.${action}`,
      entityType: 'alert',
      entityId: row.eventId,
      before: { status: currentStatus },
      after: { status: row.status },
    });
    return row;
  }
}
