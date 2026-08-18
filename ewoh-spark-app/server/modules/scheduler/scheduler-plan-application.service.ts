/**
 * SchedulerService Strangler Refactor（Task 2）：方案应用写路径。
 *
 * 承载方案状态机应用（confirmPlan / rejectPlan）、V2 审批/下发/重排拒绝
 * （approvePlanV2 / rejectPlanV2 / dispatchPlanV2 / comparePlansV2）、
 * 人工覆盖应用（applyOverrides）与策略版本人工激活（activatePolicyVersion）。
 *
 * dispatchPlanV2 在 planService.dispatchPlan 后建立 Execution 记录（P4-EXEC）；
 * applyOverrides 将手工操作转换为 SchedulingConstraint 落库 + 审计 + 复用
 * planService.replan 产出新方案，返回 before/after 差异摘要。
 */
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { currentRequestContext } from '../../common/request-context';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulePlan,
  ewohScheduleAudit,
  ewohSchedulingConstraint,
} from '@server/database/schema';
import { eq, and } from 'drizzle-orm';
import type {
  SchedulePlan,
  ScheduleAudit,
  SchedulingPlanV2,
  ApprovePlanRequest,
  RejectPlanRequest,
  PlanOverrideRequest,
  PlanOverrideResponse,
  PlanOverrideKind,
  PlanOverrideDiffSummary,
  SchedulingConstraint,
  SchedulingPolicyConfig,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { PolicyReplayService } from './policy-replay.service';
import { ExecutionService } from './execution.service';
import { toOrgContext, mapPlan, mapAudit } from './scheduler-run-context';
import { assertPlanTenantVisible } from './plan-tenant-guard';

@Injectable()
export class SchedulerPlanApplicationService {
  private readonly logger = new Logger(SchedulerPlanApplicationService.name);

  /** 可接受人工覆盖并重排的方案状态（已下发/执行/终态/审核中不重排）。 */
  private static readonly REPLANNABLE_PLAN_STATUSES = new Set([
    'draft',
    'shadow',
    'proposed',
    'approved',
  ]);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
    private readonly planService: PlanService,
    private readonly policyService: SchedulingPolicyService,
    // Phase 4 / P4-T2：Shadow Policy 真实 replay（可选注入；activate 守卫视作未评估）。
    private readonly policyReplayService?: PolicyReplayService,
    // Phase 4 / P4-EXEC：正式执行领域（可选注入；未注入时 dispatch 跳过 Execution 建立）。
    private readonly executionService?: ExecutionService,
  ) {}

  async confirmPlan(
    planId: string,
    reason: string,
    operator?: string,
    actor?: OrgContext,
  ): Promise<{ plan: SchedulePlan; audit: ScheduleAudit }> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('reason is required');
    }

    try {
      const [existing] = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(eq(ewohSchedulePlan.planId, planId))
        .limit(1);

      if (!existing) {
        throw new NotFoundException(`Schedule plan ${planId} not found`);
      }
      // ADR-071：legacy confirm/reject 变面租户守卫（反枚举 404；与 RLS 语义等价）。
      assertPlanTenantVisible(existing.orgId, actor, planId);

      const op = operator || 'supervisor';
      const now = new Date();
      const currentStatus = existing.status ?? 'proposed';
      const gucContext: OrgContext = {
        userId: actor?.userId ?? 'system',
        primaryOrgId: actor?.primaryOrgId ?? '',
        role: actor?.role,
        accessibleOrgIds:
          actor?.accessibleOrgIds ??
          (actor?.primaryOrgId ? [actor.primaryOrgId] : []),
        isGlobalAdmin: actor?.isGlobalAdmin ?? false,
      };

      return this.requestDatabaseContext.runInTransaction(
        buildGucSettings(gucContext),
        async () => {
          const [updated] = await this.db
            .update(ewohSchedulePlan)
            .set({
              status: 'confirmed',
              confirmedBy: op,
              confirmedAt: now,
              confirmReason: reason,
            })
            .where(
              and(
                eq(ewohSchedulePlan.planId, planId),
                eq(ewohSchedulePlan.status, currentStatus),
              ),
            )
            .returning();

          if (!updated) {
            throw new ConflictException('STATE_CONFLICT');
          }

          const [auditRow] = await this.db
            .insert(ewohScheduleAudit)
            .values({
              auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
              planId,
              action: 'confirm',
              // ADR-075：audit 行归属注入（001 ewoh_org_visible RLS 对齐）。
              orgId: gucContext.primaryOrgId || null,
              operator: op,
              reason,
              createdAt: now,
            })
            .returning();

          await this.auditService.appendAuditLog({
            actorId: actor?.userId ?? 'system',
            orgId: actor?.primaryOrgId ?? '',
            action: 'scheduler.confirm',
            entityType: 'schedule_plan',
            entityId: planId,
            before: {
              status: currentStatus,
              confirmReason: existing.confirmReason ?? null,
            },
            after: {
              status: 'confirmed',
              confirmedBy: op,
              confirmReason: reason,
            },
          });

          return {
            plan: mapPlan(updated),
            audit: mapAudit(auditRow),
          };
        },
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      this.logger.error('confirmPlan 失败', error);
      throw error;
    }
  }

  async rejectPlan(
    planId: string,
    reason: string,
    operator?: string,
    actor?: OrgContext,
  ): Promise<{ plan: SchedulePlan; audit: ScheduleAudit }> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('reason is required');
    }

    try {
      const [existing] = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(eq(ewohSchedulePlan.planId, planId))
        .limit(1);

      if (!existing) {
        throw new NotFoundException(`Schedule plan ${planId} not found`);
      }
      // ADR-071：legacy confirm/reject 变面租户守卫（反枚举 404；与 RLS 语义等价）。
      assertPlanTenantVisible(existing.orgId, actor, planId);

      const op = operator || 'supervisor';
      const now = new Date();
      const currentStatus = existing.status ?? 'proposed';
      const gucContext: OrgContext = {
        userId: actor?.userId ?? 'system',
        primaryOrgId: actor?.primaryOrgId ?? '',
        role: actor?.role,
        accessibleOrgIds:
          actor?.accessibleOrgIds ??
          (actor?.primaryOrgId ? [actor.primaryOrgId] : []),
        isGlobalAdmin: actor?.isGlobalAdmin ?? false,
      };

      return this.requestDatabaseContext.runInTransaction(
        buildGucSettings(gucContext),
        async () => {
          const [updated] = await this.db
            .update(ewohSchedulePlan)
            .set({
              status: 'rejected',
              confirmedBy: op,
              confirmedAt: now,
              confirmReason: reason,
            })
            .where(
              and(
                eq(ewohSchedulePlan.planId, planId),
                eq(ewohSchedulePlan.status, currentStatus),
              ),
            )
            .returning();

          if (!updated) {
            throw new ConflictException('STATE_CONFLICT');
          }

          const [auditRow] = await this.db
            .insert(ewohScheduleAudit)
            .values({
              auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
              planId,
              action: 'reject',
              // ADR-075：audit 行归属注入（001 ewoh_org_visible RLS 对齐）。
              orgId: gucContext.primaryOrgId || null,
              operator: op,
              reason,
              createdAt: now,
            })
            .returning();

          await this.auditService.appendAuditLog({
            actorId: actor?.userId ?? 'system',
            orgId: actor?.primaryOrgId ?? '',
            action: 'scheduler.reject',
            entityType: 'schedule_plan',
            entityId: planId,
            before: {
              status: currentStatus,
              confirmReason: existing.confirmReason ?? null,
            },
            after: {
              status: 'rejected',
              confirmedBy: op,
              confirmReason: reason,
            },
          });

          return {
            plan: mapPlan(updated),
            audit: mapAudit(auditRow),
          };
        },
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      this.logger.error('rejectPlan 失败', error);
      throw error;
    }
  }

  async approvePlanV2(
    planId: string,
    body: ApprovePlanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    // P1-E（§九）：人工干预版本 CAS——结构化入参 expectedPlanVersion/expectedSnapshotVersion
    // 与请求 version/snapshotVersion 不一致 → 过期拒绝（ConflictException，不自动应用）。
    // 未提供 → 现状行为（planService 内既有 PLAN_STALE/快照新鲜度兜底）。
    if (
      body.expectedPlanVersion !== undefined &&
      body.expectedPlanVersion !== body.version
    ) {
      throw new ConflictException(
        `STALE_PLAN: expected version ${body.expectedPlanVersion}, body version ${body.version}`,
      );
    }
    if (
      body.expectedSnapshotVersion !== undefined &&
      body.expectedSnapshotVersion !== body.snapshotVersion
    ) {
      throw new ConflictException(
        `STALE_SNAPSHOT: expected ${body.expectedSnapshotVersion}, body snapshot ${body.snapshotVersion}`,
      );
    }
    return this.planService.approvePlan(planId, body, toOrgContext(actor));
  }

  async rejectPlanV2(
    planId: string,
    body: RejectPlanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planService.rejectPlan(planId, body, toOrgContext(actor));
  }

  async dispatchPlanV2(
    planId: string,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    const plan = await this.planService.dispatchPlan(planId, toOrgContext(actor));
    // P4-EXEC：dispatch 后建立 Execution 记录（planned 事实；actual 由执行反馈回填）。
    if (this.executionService) {
      // DATA-FLOW-L3 修复（2026-08-18）：Execution 建档失败从"单次尝试"升级为
      // "短重试（2 次 × 500ms）"，覆盖瞬时连接/约束冲突（createFromPlan 本身
      // ON CONFLICT DO NOTHING 幂等）；重试仍失败才降级 executionSync 警告，
      // 显著缩小"已派工但无 Execution 跟踪"窗口。
      let syncError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.executionService.createFromPlan(
            {
              planId: plan.planId,
              runId: (plan as { runId?: string | null }).runId ?? null,
              snapshotVersion: plan.snapshotVersion ?? null,
              policyVersion: plan.policyVersion ?? null,
              solverVersion: plan.solverVersion ?? null,
            },
            plan.assignments.map((a) => ({
              assignmentId: a.assignmentId,
              taskId: a.taskId,
              personId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
              stationId: a.stationId ?? null,
              plannedStart: a.plannedStart ?? null,
              plannedEnd: a.plannedEnd ?? null,
              etaSeconds: a.etaSeconds,
              distanceMeters: a.distanceMeters,
            })),
            toOrgContext(actor).primaryOrgId ?? null,
            actor,
          );
          syncError = null;
          break;
        } catch (err) {
          syncError = err;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
      if (syncError) {
        // NEST-156 修复（2026-08-17）：Execution 建档失败不再只有日志——响应
        // 显式携带 executionSync 警告字段（dispatch 成功但无 Execution 跟踪
        // 是可观测的降级状态，调用方需知情）。L3 修复后此路径仅在重试耗尽后触发。
        const message = (syncError as Error)?.message ?? String(syncError);
        this.logger.warn(`execution record creation failed after 3 attempts: ${message}`);
        (plan as SchedulingPlanV2 & { executionSync?: { ok: boolean; error: string } }).executionSync = {
          ok: false,
          error: message,
        };
      }
    }
    return plan;
  }

  async comparePlansV2(
    planId: string,
    otherPlanId: string,
    actor?: OrgContext,
  ): Promise<Record<string, unknown>> {
    // NEST-030：读取透传 actor（两个方案都经 ADR-071 租户守卫）。
    return this.planService.comparePlans(planId, otherPlanId, actor);
  }

  /**
   * 显式激活指定版本（人工审批路径）：翻转 active 并写入审计。
   * Phase 4 / P4-T2 守卫：
   *   - body 必须带 approver + reason（无则 400）；
   *   - 仅允许 shadow 候选（active=false）且已完成 replay 评估的策略 activate；
   *   - 已激活版本不可重复 activate（409）。
   */
  async activatePolicyVersion(
    configVersion: number,
    body: { approver?: string; reason?: string },
    actor?: OrgContext,
  ): Promise<{ config: SchedulingPolicyConfig }> {
    const ctx = toOrgContext(actor);
    // 守卫 0/1：approver + reason 必须来自请求 body（审批要件，不静默回退 ctx）。
    const approver = body?.approver?.trim() ?? '';
    const reason = body?.reason?.trim() ?? '';

    if (!approver) {
      throw new BadRequestException('APPROVER_REQUIRED: 激活策略必须提供 approver');
    }
    if (!reason) {
      throw new BadRequestException('REASON_REQUIRED: 激活策略必须提供 reason');
    }

    // 守卫 2：版本存在且为 shadow 候选（active=false），不可重复 activate。
    const status = await this.policyService.getPolicyVersionStatus(configVersion);
    if (!status) {
      throw new NotFoundException(
        `Scheduling policy version ${configVersion} not found`,
      );
    }
    if (status.active) {
      throw new ConflictException('POLICY_ALREADY_ACTIVE');
    }

    // 守卫 3：已完成 replay 评估（shadow → 评估 → activate 闭环）。
    if (!this.policyReplayService?.isEvaluated(configVersion)) {
      throw new ConflictException(
        'POLICY_NOT_EVALUATED: 候选策略须先完成 shadow replay 评估',
      );
    }

    const config = await this.policyService.activatePolicyVersion(
      configVersion,
      ctx.primaryOrgId || null,
      approver,
      // NO-13o / ADR-064：人审理由透传（决策记录判定事实）。
      reason,
    );
    await this.auditService.appendAuditLog({
      actorId: approver,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.policy.activate',
      entityType: 'scheduling_policy',
      entityId: String(configVersion),
      before: { configVersion, active: false },
      after: { configVersion, active: true },
      reason,
    });
    return { config };
  }

  /** 人工覆盖动作 → 约束类型映射。 */
  private static readonly OVERRIDE_KIND_TO_TYPE: Record<
    PlanOverrideKind,
    SchedulingConstraint['type']
  > = {
    LOCK_PERSON: 'LOCKED_PERSON',
    LOCK_DEVICE: 'LOCKED_DEVICE',
    LOCK_STATION: 'LOCKED_STATION',
    LOCK_TIME: 'LOCKED_TIME',
    LOCK_ASSIGNMENT: 'LOCKED_ASSIGNMENT',
    EXCLUDE_RESOURCE: 'EXCLUDED_RESOURCE',
    PREFER_RESOURCE: 'PREFERRED_RESOURCE',
    BOOST: 'MANUAL_BOOST',
    ADJUST_TIME: 'LOCKED_TIME',
    // Phase 3 / P3-T4：换资源 = 锁定新的 person/device/station（LOCKED_ASSIGNMENT 组合语义）。
    CHANGE_RESOURCE: 'LOCKED_ASSIGNMENT',
  };

  /**
   * 应用人工覆盖（Task 3：cmd-map-scheduling-closed-loop）。
   * 将一组手工操作转换为 SchedulingConstraint 并落库 + 审计，
   * 通过既有 V2 重排通道（planService.replan）产出新方案，
   * 返回覆盖前后方案的 before/after 差异摘要。
   */
  async applyOverrides(
    planId: string,
    body: PlanOverrideRequest,
    actor?: OrgContext,
  ): Promise<PlanOverrideResponse> {
    const ctx = toOrgContext(actor);
    const operator = body.operator || ctx.userId;

    // 1. 校验方案存在且处于可重排状态。
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    // ADR-071：人工覆盖变面租户守卫（反枚举 404；与 RLS 语义等价）。
    assertPlanTenantVisible(plan.orgId, ctx, planId);
    if (!SchedulerPlanApplicationService.REPLANNABLE_PLAN_STATUSES.has(plan.status ?? '')) {
      throw new ConflictException('PLAN_NOT_REPLANNABLE');
    }

    // P1-E（§九）：人工干预版本 CAS——入参提供 expectedPlanVersion/expectedSnapshotVersion 时，
    // 校验与目标方案当前 version/snapshotVersion 一致；过期拒绝（ConflictException，不自动应用）。
    // 未提供 → 现状行为（向后兼容）。
    if (
      body.expectedPlanVersion !== undefined &&
      body.expectedPlanVersion !== plan.version
    ) {
      throw new ConflictException(
        `STALE_PLAN: expected version ${body.expectedPlanVersion}, current ${plan.version}`,
      );
    }
    if (
      body.expectedSnapshotVersion !== undefined &&
      body.expectedSnapshotVersion !== plan.snapshotVersion
    ) {
      throw new ConflictException(
        `STALE_SNAPSHOT: expected ${body.expectedSnapshotVersion}, current ${plan.snapshotVersion ?? ''}`,
      );
    }

    // 2. 将覆盖动作转换为 SchedulingConstraint（富化 operator/reason/validFrom/expiresAt/snapshotVersion）。
    const constraints = this.actionsToConstraints(body.actions, {
      operator,
      reason: body.reason,
      snapshotVersion: plan.snapshotVersion ?? '',
    });

    // NEST-157 修复（2026-08-17）：HTTP 路径强制 actor——空 primaryOrgId 的
    // 覆盖约束会以 orgId=null 落库（被 RLS/policy 当全局约束放行给全部租户）。
    if (!ctx.primaryOrgId && currentRequestContext()) {
      throw new UnauthorizedException(
        'org context required for plan overrides（NEST-157）',
      );
    }

    const before = await this.planService.getPlan(planId, ctx);
    let after: SchedulingPlanV2;
    // NEST-128 修复（2026-08-17）：约束落库 + 审计 + replan 收进**同一事务**——
    // 此前约束独立事务先提交，replan 失败时约束已落库（脏状态：方案未变但
    // 约束已生效，下次任意 replan 会应用孤儿约束）。RequestDatabaseContext
    // 嵌套复用同一事务（replan 内部事务加入外层）。
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        // 3. 落库约束 + 审计（复用 ewoh_scheduling_constraint / ewoh_schedule_audit / appendAuditLog 模式）。
        if (constraints.length > 0) {
          await this.db.insert(ewohSchedulingConstraint).values(
            constraints.map((c) => ({
              constraintId: c.id ?? `CON-${Date.now()}-${this.randomSuffix()}`,
              planId,
              taskId: c.taskId ?? null,
              type: c.type,
              valueJson: {
                personId: c.personId ?? null,
                deviceId: c.deviceId ?? null,
                stationId: c.stationId ?? null,
                zoneId: c.zoneId ?? null,
                startMs: c.startMs ?? null,
                endMs: c.endMs ?? null,
                operator: c.operator ?? null,
                reason: c.reason ?? null,
                validFrom: c.validFrom ?? null,
                expiresAt: c.expiresAt ?? null,
                snapshotVersion: c.snapshotVersion ?? null,
              },
              active: true,
              createdBy: ctx.userId,
              // standalone_025_scheduler_rls：租户隔离（null=全局/存量行，policy 放行）。
              // NEST-157：HTTP 路径 ctx.primaryOrgId 必非空（上方守卫）。
              orgId: ctx.primaryOrgId || null,
            })),
          );
        }
        await this.db.insert(ewohScheduleAudit).values({
          auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
          planId,
          action: 'override.apply',
          operator,
          reason: body.reason ?? '',
          createdAt: new Date(),
          // ADR-075：audit 行归属注入（001 ewoh_org_visible RLS 对齐）。
          orgId: ctx.primaryOrgId || null,
        });

        // 4. 触发重排（复用既有 V2 求解通道，不新建求解路径；同事务）。
        after = await this.planService.replan(
          planId,
          { lockedConstraints: constraints, operator, reason: body.reason },
          ctx,
        );
      },
    );

    await this.auditService.appendAuditLog({
      actorId: operator,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.plan.override',
      entityType: 'schedule_plan',
      entityId: planId,
      before: { status: plan.status, version: plan.version },
      after: { overrideCount: constraints.length, supersededBy: `${planId}-R${(plan.version ?? 1) + 1}` },
      reason: body.reason,
    });

    // 5. 返回 before/after 差异摘要。
    return {
      planId: after!.planId,
      operator,
      reason: body.reason,
      appliedConstraints: constraints,
      before,
      after: after!,
      diff: this.buildPlanDiff(before, after!),
      // T04 / P1-8：可选 preview 引用（纯计算预览 id；本流程无预览候选时置 null）。
      preview: null,
    };
  }

  /** 将人工覆盖动作转换为统一 SchedulingConstraint。 */
  private actionsToConstraints(
    actions: PlanOverrideRequest['actions'],
    meta: { operator: string; reason?: string; snapshotVersion: string },
  ): SchedulingConstraint[] {
    return actions.map((a, i) => {
      const type = SchedulerPlanApplicationService.OVERRIDE_KIND_TO_TYPE[a.kind];
      // Phase 3 / P3-T4：CHANGE_RESOURCE 优先读 changeResource 目标（新 assignee）。
      const personId = a.changeResource?.personId ?? a.personId;
      const deviceId = a.changeResource?.deviceId ?? a.deviceId;
      const stationId = a.changeResource?.stationId ?? a.stationId;
      return {
        id: `CON-${Date.now()}-${i}-${this.randomSuffix()}`,
        type,
        taskId: a.taskId,
        personId,
        deviceId,
        stationId,
        zoneId: a.zoneId,
        startMs: a.startMs,
        endMs: a.endMs,
        operator: meta.operator,
        reason: a.reason ?? meta.reason,
        validFrom: a.validFrom,
        expiresAt: a.expiresAt,
        snapshotVersion: meta.snapshotVersion,
      };
    });
  }

  /** 计算覆盖前后方案差异（分配增删改 + 指标增量）。 */
  private buildPlanDiff(
    before: SchedulingPlanV2,
    after: SchedulingPlanV2,
  ): PlanOverrideDiffSummary {
    const aByTask = new Map(before.assignments.map((x) => [x.taskId, x]));
    const bByTask = new Map(after.assignments.map((x) => [x.taskId, x]));
    const changedTaskIds: string[] = [];
    const addedTaskIds: string[] = [];
    const removedTaskIds: string[] = [];
    for (const taskId of new Set([...aByTask.keys(), ...bByTask.keys()])) {
      const x = aByTask.get(taskId);
      const y = bByTask.get(taskId);
      if (!x) addedTaskIds.push(taskId);
      else if (!y) removedTaskIds.push(taskId);
      else if (
        x.personId !== y.personId ||
        x.deviceId !== y.deviceId ||
        x.plannedStart !== y.plannedStart
      ) {
        changedTaskIds.push(taskId);
      }
    }
    return {
      changedTaskIds,
      addedTaskIds,
      removedTaskIds,
      metricsDelta: {
        lateMinutes: after.metrics.lateMinutes - before.metrics.lateMinutes,
        walkingMeters: after.metrics.walkingMeters - before.metrics.walkingMeters,
        stationWaitMinutes:
          after.metrics.stationWaitMinutes - before.metrics.stationWaitMinutes,
        maxWorkload: after.metrics.maxWorkload - before.metrics.maxWorkload,
        changeCost: after.metrics.changeCost - before.metrics.changeCost,
      },
    };
  }

  private randomSuffix(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }
}
