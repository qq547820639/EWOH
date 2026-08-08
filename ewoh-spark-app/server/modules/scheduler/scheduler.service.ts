import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulePlan,
  ewohScheduleAudit,
  ewohDevice,
  ewohTelemetry,
  ewohEvent,
  ewohSchedulingRun,
  ewohSchedulingConstraint,
} from '@server/database/schema';
import { eq, desc, and, sql, gte, lte, inArray, type SQL } from 'drizzle-orm';
import type {
  SchedulePlan,
  ScheduleAudit,
  ScheduleWeights,
  SchedulingPlanV2,
  SchedulingRun,
  RouteGraph,
  Route,
  CreateRunRequest,
  ApprovePlanRequest,
  RejectPlanRequest,
  ReplanRequest,
  CalculateRouteRequest,
  TaskCandidatesResponse,
  TaskCandidateResource,
  ListRunsRequest,
  ListRunsResponse,
  WorldStateSnapshot,
  SchedulingConflict,
  SchedulingConflictType,
  ConflictSeverity,
  SchedulingConflictScope,
  ConflictsListRequest,
  ConflictsListResponse,
  SchedulingPolicyConfig,
  SchedulingPolicy,
  SchedulingPolicyVersionSummary,
  SchedulingPolicyComparison,
  SchedulingConstraint,
  PlanOverrideRequest,
  PlanOverrideResponse,
  PlanOverrideKind,
  PlanOverrideDiffSummary,
  RecordActualsRequest,
  SchedulingEventRequest,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { TriggerService } from './trigger.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { RoutingService } from './routing.service';
import { EligibilityService } from './eligibility.service';
import { RouteCostProvider } from './route-cost.provider';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { OutboxService } from './outbox.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { TaskLifecycle } from './task-lifecycle';

/**
 * NOTE: ewoh_schedule_audit has no before_json/after_json columns in the
 * current DDL, so the before/after weight snapshots are persisted through
 * ewoh_audit_log via AuditService. The ewoh_schedule_audit row keeps the
 * action/operator/plan surface for API and query compatibility.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  /** 视为"活跃"（非终态）的方案状态，用于列出当前待处理/已批准的方案。 */
  private static readonly ACTIVE_PLAN_STATUSES = [
    'draft',
    'shadow',
    'proposed',
    'approved',
    'dispatched',
    'executing',
  ];

  /** 可接受人工覆盖并重排的方案状态（已下发/执行/终态/审核中不重排）。 */
  private static readonly REPLANNABLE_PLAN_STATUSES = new Set([
    'draft',
    'shadow',
    'proposed',
    'approved',
  ]);

  private weights: ScheduleWeights = {
    w1_output: 0.25,
    w2_on_time: 0.2,
    w3_safety_risk: 0.2,
    w4_body_load: 0.15,
    w5_move_distance: 0.1,
    w6_changeover_cost: 0.1,
  };

  /** v0.7 A2：预占过期预警阈值（ms），剩余时长低于该值产出 reservation_expiring 冲突。默认 15 分钟。 */
  private readonly reservationExpiringThresholdMs = 15 * 60 * 1000;

  private weightHistory: Array<{
    before: ScheduleWeights;
    after: ScheduleWeights;
    operator: string;
    reason: string;
    at: string;
  }> = [];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly triggerService: TriggerService,
    private readonly solverService: SolverService,
    private readonly planService: PlanService,
    private readonly routingService: RoutingService,
    private readonly eligibilityService: EligibilityService,
    private readonly routeCostProvider: RouteCostProvider,
    private readonly policyService: SchedulingPolicyService,
    private readonly feedbackService: SchedulingFeedbackService,
    // v0.7 B3：SSE 实时事件推送（conflict.detected / execution.deviation）。
    // 可选注入：测试可传 mock；缺失时静默跳过（不影响主流程）。
    private readonly outboxService?: OutboxService,
    // v0.7 Batch6.1：事件驱动级联重排（dispatchStateTriggers）。
    // 可选注入：测试可传 mock；缺失时事件仅做局部重排不级联。
    private readonly replanCoordinatorService?: ReplanCoordinatorService,
    // v0.7 Batch6.4：调度可观测指标（recordRun/recordFallback）。
    // 可选注入：测试可传 mock；缺失时静默跳过。
    private readonly metricsService?: SchedulerMetricsService,
  ) {}

  async generatePlans(body?: { idempotencyKey?: string }): Promise<SchedulePlan[]> {
    try {
      const idempotencyKey = body?.idempotencyKey?.trim();
      const idBase = idempotencyKey
        ? `PLAN-${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '')}-`
        : `PLAN-${Date.now()}-`;

      if (idempotencyKey) {
        const existingIds = [
          `${idBase}KEEP`,
          `${idBase}CAP`,
          `${idBase}BAL`,
        ];
        const existing = await this.db
          .select()
          .from(ewohSchedulePlan)
          .where(inArray(ewohSchedulePlan.planId, existingIds));
        if (existing.length > 0) {
          return existing.map((plan) => this.mapPlan(plan));
        }
      }

      // 1. 查询当前状态：设备列表与电量
      const devices = await this.db.select().from(ewohDevice);

      // 1. 查询最近 1 小时遥测：按 deviceId 分组的平均 loadScore 与 fatigueTrend
      const telemetryRows = await this.db
        .select({
          deviceId: ewohTelemetry.deviceId,
          avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
          avgFatigue: sql<number>`coalesce(avg(${ewohTelemetry.fatigueTrend}), 0)::float`,
        })
        .from(ewohTelemetry)
        .where(gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
        .groupBy(ewohTelemetry.deviceId);

      // 1. 查询未结事件
      const openEventRows = await this.db
        .select()
        .from(ewohEvent)
        .where(eq(ewohEvent.status, 'open'));

      // 2. 计算当前指标基线
      const avgLoad =
        telemetryRows.length > 0
          ? Number(
              (
                telemetryRows.reduce((sum, r) => sum + (r.avgLoad ?? 0), 0) /
                telemetryRows.length
              ).toFixed(3),
            )
          : 0;
      const lowBatteryDevices = devices.filter(
        (d) => (d.batteryPct ?? 100) < 20,
      ).length;
      const highLoadDevices = telemetryRows.filter(
        (r) => (r.avgLoad ?? 0) > 0.7,
      ).length;
      const openEvents = openEventRows.length;
      const criticalEvents = openEventRows.filter((e) =>
        ['L2', 'L3'].includes(e.severity ?? ''),
      ).length;

      // 3. 生成 3 个方案
      const plans = [
        {
          planId: `${idBase}KEEP`,
          planName: '保持现状',
          strategy: 'keep_status',
          status: 'proposed',
          taktImprovement: 0,
          highLoadPersons: highLoadDevices,
          lowBatteryRisk: lowBatteryDevices,
          affectedPersons: 0,
          metricsJson: {
            avgLoad,
            openEvents,
            criticalEvents,
            output_rate: 1.0,
            on_time_rate: 0.92,
            safety_risk: criticalEvents,
            move_distance: 0,
            changeover: 0,
          },
          reason: `维持当前人员分配与任务安排，作为基线对照。当前未结事件 ${openEvents} 项，高负荷人员 ${highLoadDevices} 人，低电量设备 ${lowBatteryDevices} 台。`,
          createdAt: new Date(),
        },
        {
          planId: `${idBase}CAP`,
          planName: '产能优先',
          strategy: 'capacity_priority',
          status: 'proposed',
          taktImprovement: 8.5,
          highLoadPersons: Math.max(highLoadDevices - 1, 0),
          lowBatteryRisk: lowBatteryDevices,
          affectedPersons: 2,
          metricsJson: {
            avgLoad: Number((avgLoad * 1.1).toFixed(3)),
            output_rate: 1.12,
            on_time_rate: 0.95,
            safety_risk: criticalEvents,
            move_distance: 320,
            changeover: 2,
          },
          reason:
            '将高产能人员调配到关键工位，预计节拍提升 8.5%，产量提升 12%。受影响 2 人，需注意负荷上升。',
          createdAt: new Date(),
        },
        {
          planId: `${idBase}BAL`,
          planName: '负荷均衡',
          strategy: 'load_balance',
          status: 'proposed',
          taktImprovement: 3.2,
          highLoadPersons: 0,
          lowBatteryRisk: Math.max(lowBatteryDevices - 1, 0),
          affectedPersons: 3,
          metricsJson: {
            avgLoad: Number((avgLoad * 0.85).toFixed(3)),
            output_rate: 1.03,
            on_time_rate: 0.94,
            safety_risk: Math.max(criticalEvents - 1, 0),
            move_distance: 480,
            changeover: 3,
          },
          reason:
            '重新均衡人员负荷，将高负荷人员任务部分转移给低负荷人员，预计平均负荷下降 15%，高风险事件减少。受影响 3 人。',
          createdAt: new Date(),
        },
      ];

      // 4. 写入数据库
      const inserted = await this.db
        .insert(ewohSchedulePlan)
        .values(plans)
        .returning();

      // 5. 返回生成的方案（含数据库生成的 id 等）
      return inserted.map((r) => this.mapPlan(r));
    } catch (error) {
      this.logger.error('generatePlans 失败', error);
      throw error;
    }
  }

  async getPlans(status?: string): Promise<SchedulePlan[]> {
    try {
      const conditions = status ? [eq(ewohSchedulePlan.status, status)] : [];
      const rows = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohSchedulePlan.createdAt))
        .limit(50);
      return rows.map((r) => this.mapPlan(r));
    } catch (error) {
      this.logger.error('getPlans 失败', error);
      throw error;
    }
  }

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
            plan: this.mapPlan(updated),
            audit: this.mapAudit(auditRow),
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
            plan: this.mapPlan(updated),
            audit: this.mapAudit(auditRow),
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

  async getAudit(planId?: string): Promise<ScheduleAudit[]> {
    try {
      const conditions = planId ? [eq(ewohScheduleAudit.planId, planId)] : [];
      const rows = await this.db
        .select()
        .from(ewohScheduleAudit)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohScheduleAudit.createdAt))
        .limit(100);
      return rows.map((r) => this.mapAudit(r));
    } catch (error) {
      this.logger.error('getAudit 失败', error);
      throw error;
    }
  }

  getWeights(): ScheduleWeights {
    return { ...this.weights };
  }

  async updateWeights(
    newWeights: ScheduleWeights,
    operator?: string,
    reason?: string,
    actor?: OrgContext,
  ): Promise<ScheduleWeights> {
    const keys: (keyof ScheduleWeights)[] = [
      'w1_output',
      'w2_on_time',
      'w3_safety_risk',
      'w4_body_load',
      'w5_move_distance',
      'w6_changeover_cost',
    ];
    for (const key of keys) {
      const v = newWeights[key];
      if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
        throw new BadRequestException(
          `weight ${key} must be a number between 0 and 1`,
        );
      }
    }

    const before = { ...this.weights };
    const op = actor?.userId ?? operator ?? 'system';
    const gucContext: OrgContext = {
      userId: op,
      primaryOrgId: actor?.primaryOrgId ?? '',
      role: actor?.role,
      accessibleOrgIds:
        actor?.accessibleOrgIds ??
        (actor?.primaryOrgId ? [actor.primaryOrgId] : []),
      isGlobalAdmin: actor?.isGlobalAdmin ?? false,
    };

    try {
      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(gucContext),
        async () => {
          await this.db.insert(ewohScheduleAudit).values({
            auditId: `AUDIT-${Date.now()}-${this.randomSuffix()}`,
            planId: 'weights',
            action: 'weights.update',
            operator: op,
            reason: reason ?? '',
            createdAt: new Date(),
          });

          await this.auditService.appendAuditLog({
            actorId: op,
            orgId: actor?.primaryOrgId ?? '',
            action: 'scheduler.weights.update',
            entityType: 'schedule_weights',
            entityId: 'weights',
            before,
            after: { ...newWeights },
            reason: reason ?? undefined,
          });

          this.weightHistory.push({
            before,
            after: { ...newWeights },
            operator: op,
            reason: reason ?? '',
            at: new Date().toISOString(),
          });
          this.weights = { ...newWeights };
        },
      );
    } catch (error) {
      this.logger.error('updateWeights 失败', error);
      throw error;
    }

    return { ...this.weights };
  }

  /**
   * 数据驱动方案生成（大脑推理增强 G3.7）
   * 基于实时遥测/事件/电量动态推算 3 个方案，而非固定模板。
   */
  async getDataDrivenPlans(): Promise<SchedulePlan[]> {
    try {
      // 1. 查询设备列表与电量
      const devices = await this.db.select().from(ewohDevice);

      // 2. 查询最近 1h 遥测：按 deviceId 分组的平均 loadScore 与 fatigueTrend
      const telemetryRows = await this.db
        .select({
          deviceId: ewohTelemetry.deviceId,
          avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
          avgFatigue: sql<number>`coalesce(avg(${ewohTelemetry.fatigueTrend}), 0)::float`,
        })
        .from(ewohTelemetry)
        .where(gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
        .groupBy(ewohTelemetry.deviceId);

      // 3. 查询未结事件（L2/L3 严重）
      const openEventRows = await this.db
        .select()
        .from(ewohEvent)
        .where(eq(ewohEvent.status, 'open'));

      // 4. 计算真实基线指标
      const totalDevices = Math.max(devices.length, 1);
      const avgLoad =
        telemetryRows.length > 0
          ? Number(
              (
                telemetryRows.reduce((sum, r) => sum + (r.avgLoad ?? 0), 0) /
                telemetryRows.length
              ).toFixed(3),
            )
          : 0;
      const avgFatigue =
        telemetryRows.length > 0
          ? Number(
              (
                telemetryRows.reduce((sum, r) => sum + (r.avgFatigue ?? 0), 0) /
                telemetryRows.length
              ).toFixed(3),
            )
          : 0;
      const lowBatteryDevices = devices.filter(
        (d) => (d.batteryPct ?? 100) < 20,
      ).length;
      const highLoadDevices = telemetryRows.filter(
        (r) => (r.avgLoad ?? 0) > 0.7,
      ).length;
      const overloadDevices = telemetryRows.filter(
        (r) => (r.avgLoad ?? 0) > 0.85,
      ).length;
      const openEvents = openEventRows.length;
      const criticalEvents = openEventRows.filter((e) =>
        ['L2', 'L3'].includes(e.severity ?? ''),
      ).length;
      const l3Events = openEventRows.filter((e) => e.severity === 'L3').length;

      // 负荷降低潜力：高负荷设备占比
      const loadReductionPotential = Number(
        (overloadDevices / totalDevices).toFixed(3),
      );
      // 准时率随负荷上升而下降
      const baseOnTimeRate = Number(
        Math.max(0.95 - avgLoad * 0.15, 0.7).toFixed(3),
      );

      const ts = Date.now();
      const now = new Date();

      // 方案 1: 保持现状（基线，真实指标）
      const keepPlan = {
        planId: `PLAN-${ts}-KEEP`,
        planName: '保持现状',
        strategy: 'keep_status',
        status: 'proposed',
        taktImprovement: 0,
        highLoadPersons: highLoadDevices,
        lowBatteryRisk: lowBatteryDevices,
        affectedPersons: 0,
        metricsJson: {
          avgLoad,
          avgFatigue,
          openEvents,
          criticalEvents,
          l3Events,
          highLoadDevices,
          lowBatteryDevices,
          output_rate: 1.0,
          on_time_rate: baseOnTimeRate,
          safety_risk: criticalEvents,
          move_distance: 0,
          changeover: 0,
        },
        reason: `维持当前人员分配与任务安排，作为基线对照。当前平均负荷 ${avgLoad}，未结事件 ${openEvents} 项（含 L2/L3 ${criticalEvents} 项），高负荷设备 ${highLoadDevices} 台，低电量设备 ${lowBatteryDevices} 台。`,
        createdAt: now,
      };

      // 方案 2: AI推荐（数据驱动：高负荷→负荷均衡，低电量→换电）
      const aiTaktImprovement = Number(
        Math.min(
          loadReductionPotential * 30 + highLoadDevices * 1.5,
          12,
        ).toFixed(1),
      );
      const aiAvgLoad = Number(
        (avgLoad * (1 - loadReductionPotential * 0.5)).toFixed(3),
      );
      const aiLowBatteryRisk = Math.max(lowBatteryDevices - 1, 0);
      const aiOnTimeRate = Number(
        Math.min(baseOnTimeRate + 0.03, 0.98).toFixed(3),
      );
      const aiReasonParts: string[] = [];
      if (overloadDevices > 0)
        aiReasonParts.push(
          `将 ${overloadDevices} 台过载设备任务转移至低负荷设备`,
        );
      if (lowBatteryDevices > 0)
        aiReasonParts.push(`优先安排 ${lowBatteryDevices} 台低电量设备换电`);
      if (l3Events > 0) aiReasonParts.push(`介入 ${l3Events} 项 L3 安全事件`);
      const aiPlan = {
        planId: `PLAN-${ts}-AI`,
        planName: 'AI推荐',
        strategy: 'load_balance',
        status: 'proposed',
        taktImprovement: aiTaktImprovement,
        highLoadPersons: Math.max(highLoadDevices - overloadDevices, 0),
        lowBatteryRisk: aiLowBatteryRisk,
        affectedPersons: Math.min(
          highLoadDevices + lowBatteryDevices,
          totalDevices,
        ),
        metricsJson: {
          avgLoad: aiAvgLoad,
          avgFatigue: Number((avgFatigue * 0.85).toFixed(3)),
          openEvents,
          criticalEvents: Math.max(criticalEvents - l3Events, 0),
          l3Events: 0,
          highLoadDevices: Math.max(highLoadDevices - overloadDevices, 0),
          lowBatteryDevices: aiLowBatteryRisk,
          output_rate: Number((1 + aiTaktImprovement / 100).toFixed(3)),
          on_time_rate: aiOnTimeRate,
          safety_risk: Math.max(criticalEvents - l3Events, 0),
          move_distance: 200 + overloadDevices * 80,
          changeover: Math.min(overloadDevices + lowBatteryDevices, 4),
          loadReductionPotential,
        },
        reason:
          aiReasonParts.length > 0
            ? `AI 数据驱动推荐：${aiReasonParts.join('；')}。预计节拍提升 ${aiTaktImprovement}%，平均负荷降至 ${aiAvgLoad}。`
            : `AI 数据驱动推荐：当前指标平稳，进行预防性负荷均衡。预计节拍提升 ${aiTaktImprovement}%。`,
        createdAt: now,
      };

      // 方案 3: 产能优先（激进产能，提升产量但负荷上升）
      const capTaktImprovement = Number(
        Math.min(8 + highLoadDevices * 1.2, 15).toFixed(1),
      );
      const capAvgLoad = Number(Math.min(avgLoad * 1.15, 0.95).toFixed(3));
      const capPlan = {
        planId: `PLAN-${ts}-CAP`,
        planName: '产能优先',
        strategy: 'capacity_priority',
        status: 'proposed',
        taktImprovement: capTaktImprovement,
        highLoadPersons: Math.min(highLoadDevices + 1, totalDevices),
        lowBatteryRisk: lowBatteryDevices,
        affectedPersons: Math.min(2 + highLoadDevices, totalDevices),
        metricsJson: {
          avgLoad: capAvgLoad,
          avgFatigue: Number((avgFatigue * 1.1).toFixed(3)),
          openEvents,
          criticalEvents,
          l3Events,
          highLoadDevices: Math.min(highLoadDevices + 1, totalDevices),
          lowBatteryDevices,
          output_rate: Number((1 + capTaktImprovement / 100).toFixed(3)),
          on_time_rate: Number(Math.max(baseOnTimeRate - 0.02, 0.7).toFixed(3)),
          safety_risk: criticalEvents,
          move_distance: 320 + highLoadDevices * 60,
          changeover: 2,
        },
        reason: `将高产能人员调配到关键工位，预计节拍提升 ${capTaktImprovement}%，产量提升 ${Math.round(capTaktImprovement)}%。受影响 ${Math.min(2 + highLoadDevices, totalDevices)} 人，需注意平均负荷上升至 ${capAvgLoad}。`,
        createdAt: now,
      };

      // 5. 写入数据库
      const inserted = await this.db
        .insert(ewohSchedulePlan)
        .values([keepPlan, aiPlan, capPlan])
        .returning();

      this.logger.log(
        `getDataDrivenPlans generated ${inserted.length} plans (avgLoad=${avgLoad}, highLoad=${highLoadDevices}, lowBattery=${lowBatteryDevices}, critical=${criticalEvents})`,
      );

      return inserted.map((r) => this.mapPlan(r));
    } catch (error) {
      this.logger.error('getDataDrivenPlans 失败', error);
      throw error;
    }
  }

  // ===== Scheduling V2 endpoints =====

  /** 创建调度运行：触发 + 求解 + 持久化方案。 */
  async createRun(
    body: CreateRunRequest,
    actor?: OrgContext,
  ): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
    const ctx = this.toOrgContext(actor);
    const trigger = body.trigger ?? 'MANUAL';
    const run = await this.triggerService.evaluate(trigger, body.entityId ?? null, ctx);
    if (!run) {
      return { run: null, plans: [], debounced: true };
    }

    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const horizonMinutes = body.horizonMinutes ?? 480;
    const plans = await this.solverService.solveVariants(
      snapshot,
      [],
      {
        planId: run.runId,
        triggerType: trigger,
        triggerEntityId: run.triggerEntityId,
        snapshotVersion: snapshot.snapshotVersion,
        horizonMinutes,
      },
    );

    for (const plan of plans) {
      await this.planService.persistPlan(plan, ctx);
    }

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohSchedulingRun)
          .set({
            status: 'succeeded',
            snapshotVersion: snapshot.snapshotVersion,
            planIds: plans.map((p) => p.planId),
          })
          .where(eq(ewohSchedulingRun.runId, run.runId));
      },
    );

    return { run, plans, debounced: false };
  }

  async getRun(runId: string): Promise<SchedulingRun | null> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulingRun)
      .where(eq(ewohSchedulingRun.runId, runId))
      .limit(1);
    if (!row) return null;
    return this.mapRun(row);
  }

  /**
   * 分页查询调度运行历史 + 返回当前活跃方案列表。
   * - runs：按过滤器（status / from / to）分页的 SchedulingRun 记录；
   * - plans：状态为非终态的活跃方案（proposed/shadow/draft/approved/dispatched/executing）；
   * - total：满足过滤条件的运行总条数（用于分页）。
   * 复用现有 db（drizzle）与 planService.getPlan，不引入并行调度器。
   */
  async listRuns(params: ListRunsRequest = {}): Promise<ListRunsResponse> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));

    const conditions: SQL[] = [];
    if (params.status) {
      conditions.push(eq(ewohSchedulingRun.status, params.status));
    }
    if (params.from && !Number.isNaN(Date.parse(params.from))) {
      conditions.push(gte(ewohSchedulingRun.createdAt, new Date(params.from)));
    }
    if (params.to && !Number.isNaN(Date.parse(params.to))) {
      conditions.push(lte(ewohSchedulingRun.createdAt, new Date(params.to)));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRows, runRows, activePlanRows] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(ewohSchedulingRun)
        .where(whereClause),
      this.db
        .select()
        .from(ewohSchedulingRun)
        .where(whereClause)
        .orderBy(desc(ewohSchedulingRun.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select()
        .from(ewohSchedulePlan)
        .where(inArray(ewohSchedulePlan.status, SchedulerService.ACTIVE_PLAN_STATUSES))
        .orderBy(desc(ewohSchedulePlan.createdAt)),
    ]);

    const runs = runRows.map((r) => this.mapRun(r));
    const plans = (
      await Promise.all(
        activePlanRows.map((p) =>
          this.planService.getPlan(p.planId).catch((err) => {
            this.logger.warn(
              `listRuns: 活跃方案 ${p.planId} 读取失败，已跳过: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }),
        ),
      )
    ).filter((p): p is SchedulingPlanV2 => p !== null);

    return {
      runs,
      plans,
      total: countRows[0]?.count ?? 0,
      page,
      pageSize,
    };
  }

  /**
   * P0-1 Active Plan 权威查询：返回当前所有非终态方案（shadow/proposed/
   * draft/approved/dispatched/executing），按创建时间倒序。
   *
   * 前端页面刷新 / SSE resync / 多终端必须从此处重新拉取权威方案，
   * SSE 仅作为增量更新机制，不作为唯一状态源。
   */
  async getActivePlans(): Promise<SchedulingPlanV2[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(inArray(ewohSchedulePlan.status, SchedulerService.ACTIVE_PLAN_STATUSES))
      .orderBy(desc(ewohSchedulePlan.createdAt));
    const plans = await Promise.all(
      rows.map((p) =>
        this.planService.getPlan(p.planId).catch((err) => {
          this.logger.warn(
            `getActivePlans: 活跃方案 ${p.planId} 读取失败，已跳过: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }),
      ),
    );
    return plans.filter((p): p is SchedulingPlanV2 => p !== null);
  }

  /**
   * 返回 map 与调度共享的当前权威世界状态快照。
   * 复用 WorldStateSnapshotService.getCurrentWorldState() 的真实当前状态（不持久化、不虚构），
   * 以 snapshotVersion='CURRENT' + 当前 ts 包装为 WorldStateSnapshot。
   */
  async getSnapshot(): Promise<WorldStateSnapshot> {
    const state = await this.worldStateSnapshotService.getCurrentWorldState();
    return {
      ...state,
      snapshotVersion: 'CURRENT',
      ts: new Date().toISOString(),
    };
  }

  async getPlanDetail(planId: string): Promise<SchedulingPlanV2> {
    return this.planService.getPlan(planId);
  }

  // ===== SchedulingPolicy versioning (Task 6: 命令图调度闭环) =====

  /** 返回当前生效策略 + 配置（只读）。 */
  async getPolicy(): Promise<{ policy: SchedulingPolicy; config: SchedulingPolicyConfig }> {
    const [policy, config] = await Promise.all([
      this.policyService.getActivePolicy(),
      this.policyService.getConfig(),
    ]);
    return { policy, config };
  }

  /** 列出全部策略版本（含 active 标志、操作人、创建时间）。 */
  async listPolicyVersions(): Promise<SchedulingPolicyVersionSummary[]> {
    return this.policyService.listVersions();
  }

  /** 注册一个候选策略版本（inactive，绝不自动激活）。 */
  async registerPolicyVersion(
    config: SchedulingPolicyConfig,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyConfig> {
    const ctx = this.toOrgContext(actor);
    return this.policyService.registerCandidatePolicy(
      config,
      ctx.primaryOrgId || null,
      ctx.userId,
    );
  }

  /**
   * shadow/只读对比：候选版本 vs 当前生效版本。
   * 由 Feedback 派生 KPI 进行离线评估 + 目标权重对比，不激活任何版本。
   */
  async comparePolicyVersion(
    configVersion: number,
    actor?: OrgContext,
  ): Promise<SchedulingPolicyComparison> {
    const ctx = this.toOrgContext(actor);
    const [activeConfig, candidateConfig, feedbackKpis] = await Promise.all([
      this.policyService.getConfig(),
      this.policyService.getConfigByVersion(configVersion),
      this.feedbackService.deriveKpis(),
    ]);
    if (!candidateConfig) {
      throw new NotFoundException(
        `Scheduling policy version ${configVersion} not found`,
      );
    }
    const paramDeltas = this.buildConfigParamDeltas(activeConfig, candidateConfig);
    return {
      candidateVersion: configVersion,
      activeVersion: activeConfig.configVersion,
      feedbackKpis,
      paramDeltas,
      objective: this.estimateObjective(activeConfig, candidateConfig),
      verdict: this.buildVerdict(paramDeltas),
      readOnly: true,
    };
  }

  /**
   * v0.7 Batch6.1 事件驱动智能重排（service 层入口，取代 controller 直连）。
   * 1. 事件 → ReplanCoordinator 局部重排（影响分析 → 冻结无关任务 → 子图求解 → 熔断）；
   * 2. 级联：基于最新世界状态检查路由阻断/拥塞/预占冲突，逐条触发 scoped 重排
   *    （TriggerService 冷却去抖 + 幂等去重天然防风暴）。
   * 缺失 replanCoordinatorService（测试/降级）时返回空结果。
   */
  async injectSchedulingEvent(
    body: SchedulingEventRequest,
    actor?: OrgContext,
  ): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean; cascaded: string[] }> {
    const ctx = this.toOrgContext(actor);
    if (!this.replanCoordinatorService) {
      return { run: null, plans: [], debounced: true, cascaded: [] };
    }
    const primary = await this.replanCoordinatorService.handleTrigger(
      body.trigger,
      body.entityId ?? null,
      ctx,
    );

    // v0.7 Batch6.4：事件驱动调度可观测埋点（成功/回退/级联数）。
    if (this.metricsService) {
      this.metricsService.recordRun({
        durationMs: 0, // 事件驱动路径耗时由 handleTrigger 内部测量，此处仅计数
        feasible: !primary.debounced,
        solverStatus: primary.run?.status ?? 'debounced',
      });
      if (primary.debounced) this.metricsService.recordFallback();
    }

    // 级联：事件处理后，世界状态中的路由/预占问题自动触发 scoped 重排。
    let cascaded: string[] = [];
    try {
      const state = await this.worldStateSnapshotService.buildSnapshot(ctx);
      const dispatched = await this.replanCoordinatorService.dispatchStateTriggers(state, ctx);
      cascaded = dispatched.map((d) => d.triggerType);
    } catch (e) {
      this.logger.warn(
        `cascade state triggers failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return { ...primary, cascaded };
  }

  /**
   * v0.7 D1 反馈闭环：回填任务执行实际值（actualStart/actualEnd/实际资源等）。
   * 委托 SchedulingFeedbackService.recordActuals（按 assignmentId/planId/taskId 匹配更新）。
   * 匹配语义：至少提供一个匹配键，否则拒绝；重复回填为覆盖式更新（天然幂等）。
   * 调用方：POST /api/scheduler/feedback/actuals（任务执行方/移动端/边缘）。
   */
  async recordTaskActuals(
    input: RecordActualsRequest,
    actor?: OrgContext,
  ): Promise<{ ok: boolean; matched: boolean }> {
    if (
      !input.assignmentId &&
      !input.planId &&
      !input.taskId
    ) {
      throw new BadRequestException(
        '至少提供一个匹配键（assignmentId / planId / taskId）',
      );
    }
    const ctx = this.toOrgContext(actor);
    await this.feedbackService.recordActuals(
      {
        planId: input.planId,
        assignmentId: input.assignmentId,
        taskId: input.taskId,
        actualStart: input.actualStart ?? null,
        actualEnd: input.actualEnd ?? null,
        actualTravel: input.actualTravel ?? null,
        actualWait: input.actualWait ?? null,
        actualResource: input.actualResource ?? null,
      },
      ctx,
    );
    // v0.7 B3：执行偏差实时推送（SSE execution.deviation），供地图执行偏差图层消费。
    // 观测型：推送失败仅记日志，不影响回填主流程。
    if (this.outboxService) {
      Promise.resolve(
        this.outboxService.enqueue(
          'execution.deviation',
          input.taskId ?? input.assignmentId ?? 'unknown',
          {
            planId: input.planId ?? null,
            assignmentId: input.assignmentId ?? null,
            taskId: input.taskId ?? null,
            actualStart: input.actualStart ?? null,
            actualEnd: input.actualEnd ?? null,
            actualTravel: input.actualTravel ?? null,
            actualWait: input.actualWait ?? null,
          },
          ctx.primaryOrgId || null,
        ),
      ).catch((e) => {
        this.logger.warn(`execution.deviation enqueue failed: ${(e as Error).message}`);
      });
    }
    // recordActuals 为更新语义（无行则不写）；matched 交由调用方以查询反馈行确认，
    // 此处统一返回 ok（观测型回填不阻断执行方）。
    return { ok: true, matched: true };
  }

  /**
   * 显式激活指定版本（人工审批路径）：翻转 active 并写入审计。
   * 这是唯一激活生产策略的入口。
   */
  async activatePolicyVersion(
    configVersion: number,
    actor?: OrgContext,
  ): Promise<{ config: SchedulingPolicyConfig }> {
    const ctx = this.toOrgContext(actor);
    const config = await this.policyService.activatePolicyVersion(
      configVersion,
      ctx.primaryOrgId || null,
      ctx.userId,
    );
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'scheduler.policy.activate',
      entityType: 'scheduling_policy',
      entityId: String(configVersion),
      before: { configVersion },
      after: { configVersion, active: true },
      reason: 'manual approval activation (Task 6)',
    });
    return { config };
  }

  /** 计算候选 vs 生效配置的标量与 priority 子字段差异。 */
  private buildConfigParamDeltas(
    active: SchedulingPolicyConfig,
    candidate: SchedulingPolicyConfig,
  ): Record<string, { active: unknown; candidate: unknown }> {
    const deltas: Record<string, { active: unknown; candidate: unknown }> = {};
    const scalarKeys: (keyof SchedulingPolicyConfig)[] = [
      'minBatteryPct',
      'maxContinuousLoad',
      'defaultTaskDurationMs',
      'horizonMinutes',
      'walkingSpeedMps',
      'euclideanDistanceWeight',
      'congestedFactor',
      'blockedFactor',
      'highRiskFactor',
      'mediumRiskFactor',
      'triggerCooldownMs',
    ];
    for (const k of scalarKeys) {
      if (active[k] !== candidate[k]) {
        deltas[k] = { active: active[k], candidate: candidate[k] };
      }
    }
    const priorityKeys: (keyof SchedulingPolicyConfig['priority'])[] = [
      'deadlineRiskWeight',
      'waitingAgeWeight',
      'eventSeverityWeight',
      'productionImpactWeight',
      'downstreamBlockingWeight',
      'manualBoostWeight',
      'agingBaseMs',
    ];
    for (const k of priorityKeys) {
      if (active.priority[k] !== candidate.priority[k]) {
        deltas[`priority.${k}`] = {
          active: active.priority[k],
          candidate: candidate.priority[k],
        };
      }
    }
    return deltas;
  }

  /** 基于求解目标权重（与 buildPolicy 一致）的归一化 composite objective 估计。 */
  private estimateObjective(
    active: SchedulingPolicyConfig,
    candidate: SchedulingPolicyConfig,
  ): { active: number; candidate: number } {
    const score = (c: SchedulingPolicyConfig): number =>
      c.priority.deadlineRiskWeight * 3 +
      c.euclideanDistanceWeight +
      c.highRiskFactor / 2 +
      c.minBatteryPct / 30;
    return { active: score(active), candidate: score(candidate) };
  }

  private buildVerdict(
    deltas: Record<string, { active: unknown; candidate: unknown }>,
  ): string {
    const changed = Object.keys(deltas);
    if (changed.length === 0) {
      return '候选版本与生效版本参数完全一致，无实际变更。';
    }
    return `候选版本相对生效版本存在 ${changed.length} 项参数差异（${changed.join(
      ', ',
    )}）；请结合反馈 KPI 决策，本结果仅为只读 shadow 对比。`;
  }

  /** P0-2：查询方案仍生效的持久化人工约束。 */
  async listPlanConstraintsV2(planId: string) {
    return this.planService.listPlanConstraints(planId);
  }

  /** P0-2：解除一条人工约束（软删除 + 审计）。 */
  async deactivateConstraintV2(
    constraintId: string,
    actor?: OrgContext,
    reason = '',
  ) {
    return this.planService.deactivateConstraint(
      constraintId,
      this.toOrgContext(actor),
      reason,
    );
  }

  async approvePlanV2(
    planId: string,
    body: ApprovePlanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planService.approvePlan(planId, body, this.toOrgContext(actor));
  }

  async rejectPlanV2(
    planId: string,
    body: RejectPlanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planService.rejectPlan(planId, body, this.toOrgContext(actor));
  }

  async dispatchPlanV2(
    planId: string,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planService.dispatchPlan(planId, this.toOrgContext(actor));
  }

  async replanV2(
    planId: string,
    body: ReplanRequest,
    actor?: OrgContext,
  ): Promise<SchedulingPlanV2> {
    return this.planService.replan(planId, body, this.toOrgContext(actor));
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
    const ctx = this.toOrgContext(actor);
    const operator = body.operator || ctx.userId;

    // 1. 校验方案存在且处于可重排状态。
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) throw new NotFoundException(`Plan ${planId} not found`);
    if (!SchedulerService.REPLANNABLE_PLAN_STATUSES.has(plan.status ?? '')) {
      throw new ConflictException('PLAN_NOT_REPLANNABLE');
    }

    // 2. 将覆盖动作转换为 SchedulingConstraint（富化 operator/reason/validFrom/expiresAt/snapshotVersion）。
    const constraints = this.actionsToConstraints(body.actions, {
      operator,
      reason: body.reason,
      snapshotVersion: plan.snapshotVersion ?? '',
    });

    // 3. 落库约束 + 审计（复用 ewoh_scheduling_constraint / ewoh_schedule_audit / appendAuditLog 模式）。
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
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
        });
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

    // 4. 触发重排（复用既有 V2 求解通道，不新建求解路径）。
    const before = await this.planService.getPlan(planId);
    const after = await this.planService.replan(
      planId,
      { lockedConstraints: constraints, operator, reason: body.reason },
      ctx,
    );

    // 5. 返回 before/after 差异摘要。
    return {
      planId: after.planId,
      operator,
      reason: body.reason,
      appliedConstraints: constraints,
      before,
      after,
      diff: this.buildPlanDiff(before, after),
    };
  }

  /** 将人工覆盖动作转换为统一 SchedulingConstraint。 */
  private actionsToConstraints(
    actions: PlanOverrideRequest['actions'],
    meta: { operator: string; reason?: string; snapshotVersion: string },
  ): SchedulingConstraint[] {
    return actions.map((a, i) => {
      const type = SchedulerService.OVERRIDE_KIND_TO_TYPE[a.kind];
      return {
        id: `CON-${Date.now()}-${i}-${this.randomSuffix()}`,
        type,
        taskId: a.taskId,
        personId: a.personId,
        deviceId: a.deviceId,
        stationId: a.stationId,
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

  async comparePlansV2(
    planId: string,
    otherPlanId: string,
  ): Promise<Record<string, unknown>> {
    return this.planService.comparePlans(planId, otherPlanId);
  }

  async getRoutes(): Promise<RouteGraph> {
    return this.routingService.loadGraph();
  }

  async calculateRouteV2(body: CalculateRouteRequest): Promise<Route> {
    return this.routingService.calculateRoute(body.personId, body.taskId);
  }

  /**
   * 任务候选资源：为指定任务返回可派人员×设备的资格/路径评估列表。
   * 复用现有 EligibilityService 与 RouteCostProvider（不重复实现规则）。
   * 任务已分配/锁定仍返回候选，但标记 assigned 与当前受让人。
   */
  async getTaskCandidates(taskId: string): Promise<TaskCandidatesResponse> {
    const state = await this.worldStateSnapshotService.getCurrentWorldState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    const policy = await this.policyService.getActivePolicy();
    const config = await this.policyService.getConfig();
    const now = Date.now();

    const stationById = new Map(state.stations.map((s) => [s.id, s]));
    const taskStation = task.stationId ? stationById.get(task.stationId) : undefined;
    const taskPoint = taskStation
      ? { x: taskStation.x, y: taskStation.y }
      : undefined;

    const doneTaskIds = new Set<string>(
      state.tasks
        .filter((t) => TaskLifecycle.isTerminal(t.status))
        .map((t) => t.id),
    );

    const bookedTimeSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'person')
      .map((r) => ({ personId: r.resourceId, start: r.startMs, end: r.endMs }));
    const bookedDeviceSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'device')
      .map((r) => ({ deviceId: r.resourceId, start: r.startMs, end: r.endMs }));
    const bookedStationSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'station')
      .map((r) => ({ stationId: r.resourceId, start: r.startMs, end: r.endMs }));

    const forbiddenZones = (state.forbiddenZones ?? []).map((f) => f.zoneId);
    const safetyBlockedPersonIds = state.safetyBlockedPersonIds ?? [];

    const candidateStartMs = task.planStart ? Date.parse(task.planStart) : now;
    const candidateEndMs = task.planEnd
      ? Date.parse(task.planEnd)
      : now + (config.defaultTaskDurationMs ?? 1_800_000);

    const lockedByTask = (state.lockedAssignments ?? []).find(
      (la) => la.taskId === taskId,
    );
    const assigned = Boolean(task.assigneeId || lockedByTask?.personId);
    const lockedAssigneeId = task.assigneeId ?? lockedByTask?.personId ?? null;
    const lockedDeviceId = task.deviceId ?? lockedByTask?.deviceId ?? null;

    const requiredCaps = task.requiredDeviceCapabilities ?? [];
    // 设备候选：全部设备（资格判定负责 battery/offline/capability 排除）+ 无能力要求时的纯手工(null)。
    const deviceCandidates: Array<(typeof state.devices)[number] | null> = [
      ...state.devices,
    ];
    if (requiredCaps.length === 0) deviceCandidates.push(null);

    const lockedPersonIds = Array.from(
      new Set(
        (state.lockedAssignments ?? [])
          .filter((la) => la.taskId !== taskId)
          .map((la) => la.personId ?? '')
          .filter(Boolean),
      ),
    );

    const candidates: TaskCandidateResource[] = [];

    for (const person of state.persons) {
      const personStation = person.stationId
        ? stationById.get(person.stationId)
        : undefined;
      const personPoint = personStation
        ? { x: personStation.x, y: personStation.y }
        : { x: person.x, y: person.y };

      const routeCost = await this.routeCostProvider.estimate(
        person.id,
        task.id,
        personPoint,
        taskPoint,
      );
      const routeInfeasible = routeCost.feasible === false;

      for (const device of deviceCandidates) {
        const eligibility = this.eligibilityService.check(
          {
            id: person.id,
            status: person.status,
            skills: person.skills,
            certifications: person.certifications,
            stationId: person.stationId,
            loadLevel: person.loadLevel,
            fatigueLevel: person.fatigueLevel,
            healthStatus: person.healthStatus,
          },
          {
            id: task.id,
            taskType: task.taskType,
            requiredSkills: task.requiredSkills,
            skillMatchMode: task.skillMatchMode,
            requiredCertifications: task.requiredCertifications,
            stationId: task.stationId,
            zoneId: task.zoneId,
            predIds: task.predecessorIds,
            requiredDeviceCapabilities: requiredCaps,
          },
          device
            ? {
                id: device.id,
                batteryPct: device.batteryPct,
                online: device.online,
                status: device.status,
                capabilities: device.capabilities ?? [],
              }
            : null,
          {
            now,
            bookedTimeSlots,
            bookedDeviceSlots,
            bookedStationSlots,
            lockedPersonIds,
            forbiddenZones,
            minBatteryPct: config.minBatteryPct,
            maxContinuousLoad: config.maxContinuousLoad,
            safetyBlockedPersonIds,
            predecessorDone: (id) => doneTaskIds.has(id),
            candidateStartMs,
            candidateEndMs,
          },
        );

        const reasons = [...eligibility.reasons];
        if (routeInfeasible) reasons.push('route_infeasible');

        const eligible = eligibility.eligible && !routeInfeasible;
        const reservationConflict = eligibility.reasons.some((r) =>
          ['time_conflict', 'device_reserved', 'station_reserved'].includes(r),
        );
        const skillMatch = !eligibility.reasons.includes('missing_skill');
        const score = eligible
          ? routeCost.etaSeconds + person.loadLevel * 60
          : Number.POSITIVE_INFINITY;

        candidates.push({
          personId: person.id,
          personName: person.name,
          deviceId: device ? device.id : null,
          stationId: task.stationId,
          eligible,
          etaSeconds: routeCost.etaSeconds,
          distanceMeters: routeCost.distanceMeters,
          skillMatch,
          workload: person.loadLevel,
          batteryPct: device ? device.batteryPct : null,
          reservationConflict,
          score,
          reasons,
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.score !== b.score) return a.score - b.score;
      if (a.personId !== b.personId) return a.personId < b.personId ? -1 : 1;
      const da = a.deviceId ?? '';
      const db = b.deviceId ?? '';
      return da < db ? -1 : da > db ? 1 : 0;
    });

    return {
      taskId: task.id,
      taskTitle: task.title ?? null,
      taskStatus: task.status ?? null,
      assigned,
      lockedAssigneeId,
      lockedDeviceId,
      solverVersion: policy.solverVersion,
      candidates,
      generatedAt: new Date().toISOString(),
    };
  }

  // ===== Conflict aggregation (V2) =====

  /**
   * 从真实世界状态 / 预占 / 活跃方案聚合统一调度冲突列表。
   * 仅返回真实/可推导冲突；无冲突时返回空列表，不虚构。
   */
  async listConflicts(params: ConflictsListRequest = {}): Promise<ConflictsListResponse> {
    let conflicts = await this.buildConflicts();
    if (params.type) conflicts = conflicts.filter((c) => c.type === params.type);
    if (params.severity) conflicts = conflicts.filter((c) => c.severity === params.severity);
    if (params.scope) conflicts = conflicts.filter((c) => c.scope === params.scope);
    if (params.resourceId) conflicts = conflicts.filter((c) => c.resourceId === params.resourceId);
    conflicts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { conflicts, total: conflicts.length };
  }

  /** 返回单个冲突详情；冲突在当前真实数据中不再存在时抛 NotFoundException。 */
  async getConflictDetail(conflictId: string): Promise<SchedulingConflict> {
    const { conflicts } = await this.listConflicts({});
    const found = conflicts.find((c) => c.conflictId === conflictId);
    if (!found) throw new NotFoundException(`Conflict ${conflictId} not found`);
    return found;
  }

  /** 从当前世界状态 / 预占 / 活跃方案推导全部真实冲突。 */
  private async buildConflicts(): Promise<SchedulingConflict[]> {
    const state = await this.worldStateSnapshotService.getCurrentWorldState();
    const config = (await this.policyService
      .getConfig()
      .catch(() => null)) as SchedulingPolicyConfig | null;
    const minBatteryPct = config?.minBatteryPct ?? 15;
    const now = Date.now();
    const conflicts: SchedulingConflict[] = [];

    const terminalStatuses = new Set(['done', 'completed', 'cancelled', 'failed']);
    const affectedTasks = state.tasks.filter((t) => !terminalStatuses.has(t.status));

    const taskIdsFor = (kind: 'person' | 'device', id: string): string[] =>
      affectedTasks
        .filter((t) => (kind === 'person' ? t.assigneeId === id : t.deviceId === id))
        .map((t) => t.id);

    // 1. double booking：同一资源时间窗重叠的预占。
    const resByKey = new Map<string, typeof state.reservations>();
    for (const r of state.reservations ?? []) {
      const key = `${r.resourceType}:${r.resourceId}`;
      const list = resByKey.get(key) ?? [];
      list.push(r);
      resByKey.set(key, list);
    }
    for (const [key, list] of resByKey) {
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          if (a.startMs < b.endMs && b.startMs < a.endMs) {
            const [resourceType, resourceId] = key.split(':');
            conflicts.push(
              this.mkConflict(
                `double_booking:${key}:${a.reservationId}:${b.reservationId}`,
                {
                  type: 'double_booking',
                  severity: 'critical',
                  scope: 'resource',
                  resourceType,
                  resourceId,
                  taskIds: [],
                  message: `资源 ${resourceId}（${resourceType}）存在重叠预占：${a.reservationId} 与 ${b.reservationId}`,
                  resolution: '释放其中一条预占或调整时间窗',
                  snapshotVersion: 'CURRENT',
                  data: {
                    reservationIds: [a.reservationId, b.reservationId],
                    overlapStartMs: Math.max(a.startMs, b.startMs),
                    overlapEndMs: Math.min(a.endMs, b.endMs),
                  },
                },
              ),
            );
          }
        }
      }
    }

    // 2. resource stale：STALE / UNKNOWN 数据不被视为可信。
    for (const p of state.persons) {
      if (p.dataQuality === 'STALE' || p.dataQuality === 'UNKNOWN') {
        conflicts.push(
          this.mkConflict(`resource_stale:person:${p.id}`, {
            type: 'resource_stale',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'person',
            resourceId: p.id,
            taskIds: taskIdsFor('person', p.id),
            message: `人员 ${p.name ?? p.id} 数据陈旧（${p.dataQuality}）`,
            resolution: '等待遥测更新或人工确认状态',
            snapshotVersion: 'CURRENT',
            data: { dataQuality: p.dataQuality },
          }),
        );
      }
    }
    for (const d of state.devices) {
      if (d.dataQuality === 'STALE' || d.dataQuality === 'UNKNOWN') {
        conflicts.push(
          this.mkConflict(`resource_stale:device:${d.id}`, {
            type: 'resource_stale',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'device',
            resourceId: d.id,
            taskIds: taskIdsFor('device', d.id),
            message: `设备 ${d.id} 数据陈旧（${d.dataQuality}）`,
            resolution: '等待遥测更新确认状态',
            snapshotVersion: 'CURRENT',
            data: { dataQuality: d.dataQuality },
          }),
        );
      }
    }

    // 3. person unavailable：数据新鲜但状态不可用。
    for (const p of state.persons) {
      if (p.dataQuality === 'FRESH' && p.status === 'unavailable') {
        conflicts.push(
          this.mkConflict(`person_unavailable:${p.id}`, {
            type: 'person_unavailable',
            severity: 'high',
            scope: 'resource',
            resourceType: 'person',
            resourceId: p.id,
            taskIds: taskIdsFor('person', p.id),
            message: `人员 ${p.name ?? p.id} 当前不可用`,
            resolution: '改派其他人员或等待其恢复',
            snapshotVersion: 'CURRENT',
            data: { status: p.status },
          }),
        );
      }
    }

    // 4. device offline。
    for (const d of state.devices) {
      if (d.online === false || d.status === 'offline') {
        conflicts.push(
          this.mkConflict(`device_offline:${d.id}`, {
            type: 'device_offline',
            severity: 'high',
            scope: 'resource',
            resourceType: 'device',
            resourceId: d.id,
            taskIds: taskIdsFor('device', d.id),
            message: `设备 ${d.id} 离线`,
            resolution: '检查设备连接或改派其他设备',
            snapshotVersion: 'CURRENT',
            data: { status: d.status },
          }),
        );
      }
    }

    // 5. low battery。
    for (const d of state.devices) {
      if (d.batteryPct < minBatteryPct) {
        conflicts.push(
          this.mkConflict(`low_battery:${d.id}`, {
            type: 'low_battery',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'device',
            resourceId: d.id,
            taskIds: taskIdsFor('device', d.id),
            message: `设备 ${d.id} 电量 ${d.batteryPct}% 低于阈值 ${minBatteryPct}%`,
            resolution: '安排设备充电或换电',
            snapshotVersion: 'CURRENT',
            data: { batteryPct: d.batteryPct, minBatteryPct },
          }),
        );
      }
    }

    // 6. blocked route：路段状态非 open。
    for (const r of state.routeStatus ?? []) {
      if (r.status !== 'open') {
        conflicts.push(
          this.mkConflict(`blocked_route:${r.edgeId}`, {
            type: 'blocked_route',
            severity: 'high',
            scope: 'route',
            resourceType: 'route',
            resourceId: r.edgeId,
            taskIds: [],
            message: `路段 ${r.edgeId} 不可通行（${r.status}）`,
            resolution: '求解时排除该路段并绕行',
            snapshotVersion: 'CURRENT',
            data: { status: r.status, riskLevel: r.riskLevel },
          }),
        );
      }
    }

    // 7. forbidden zone：受限制区域 + 安全事件派生区域。
    for (const z of state.forbiddenZones ?? []) {
      const zoneTaskIds = affectedTasks
        .filter((t) => t.zoneId === z.zoneId)
        .map((t) => t.id);
      conflicts.push(
        this.mkConflict(`forbidden_zone:${z.zoneId}`, {
          type: 'forbidden_zone',
          severity: 'critical',
          scope: 'route',
          resourceType: 'zone',
          resourceId: z.zoneId,
          taskIds: zoneTaskIds,
          message: `区域 ${z.zoneId} 被禁止进入（${z.reason}）`,
          resolution: '取消该区域任务或人工介入',
          snapshotVersion: 'CURRENT',
          data: { reason: z.reason },
        }),
      );
    }

    // 8. safety block：安全事件触发的禁用人员/设备。
    for (const pid of state.safetyBlockedPersonIds ?? []) {
      conflicts.push(
        this.mkConflict(`safety_block:person:${pid}`, {
          type: 'safety_block',
          severity: 'critical',
          scope: 'resource',
          resourceType: 'person',
          resourceId: pid,
          taskIds: taskIdsFor('person', pid),
          message: `人员 ${pid} 因安全事件被禁止作业`,
          resolution: '确认安全事件消除后人工恢复',
          snapshotVersion: 'CURRENT',
          data: {},
        }),
      );
    }
    for (const did of state.safetyBlockedDeviceIds ?? []) {
      conflicts.push(
        this.mkConflict(`safety_block:device:${did}`, {
          type: 'safety_block',
          severity: 'critical',
          scope: 'resource',
          resourceType: 'device',
          resourceId: did,
          taskIds: taskIdsFor('device', did),
          message: `设备 ${did} 因安全事件被禁止启用`,
          resolution: '确认安全事件消除后人工恢复',
          snapshotVersion: 'CURRENT',
          data: {},
        }),
      );
    }

    // 9. predecessor violation：前置任务未完成仍被调度。
    const statusById = new Map(state.tasks.map((t) => [t.id, t.status]));
    for (const t of affectedTasks) {
      const pendingPreds = (t.predecessorIds ?? []).filter(
        (pid) => !terminalStatuses.has(statusById.get(pid) ?? ''),
      );
      if (pendingPreds.length > 0) {
        conflicts.push(
          this.mkConflict(`predecessor_violation:${t.id}`, {
            type: 'predecessor_violation',
            severity: 'high',
            scope: 'task',
            resourceType: null,
            resourceId: null,
            taskIds: [t.id],
            message: `任务 ${t.id} 的前置任务（${pendingPreds.join(', ')}）尚未完成`,
            resolution: '等待前置任务完成或调整依赖',
            snapshotVersion: 'CURRENT',
            data: { predecessorIds: pendingPreds },
          }),
        );
      }
    }

    // 10. station capacity：工位任务数量超过容量。
    const backlogCountById = new Map<string, number>();
    for (const b of state.backlog ?? []) backlogCountById.set(b.taskId, b.count);
    for (const s of state.stations ?? []) {
      if (s.capacity == null) continue;
      const count = backlogCountById.get(s.id) ?? 0;
      if (count > s.capacity) {
        conflicts.push(
          this.mkConflict(`station_capacity:${s.id}`, {
            type: 'station_capacity',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'station',
            resourceId: s.id,
            taskIds: [],
            message: `工位 ${s.name ?? s.id} 任务数 ${count} 超过容量 ${s.capacity}`,
            resolution: '向其他空闲工位分流任务',
            snapshotVersion: 'CURRENT',
            data: { capacity: s.capacity, count },
          }),
        );
      }
    }

    // 11. stale plan：活跃方案基于已过期的快照。
    const activePlans = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(inArray(ewohSchedulePlan.status, SchedulerService.ACTIVE_PLAN_STATUSES));
    for (const p of activePlans) {
      if (!p.snapshotVersion) continue;
      const stale = await this.worldStateSnapshotService.isPlanStale(p.snapshotVersion);
      if (stale) {
        conflicts.push(
          this.mkConflict(`stale_plan:${p.planId}`, {
            type: 'stale_plan',
            severity: 'medium',
            scope: 'plan',
            resourceType: null,
            resourceId: null,
            taskIds: [],
            message: `方案 ${p.planId} 基于的快照 ${p.snapshotVersion} 已过期`,
            resolution: '基于最新快照重新运行调度生成新方案',
            snapshotVersion: p.snapshotVersion,
            data: { snapshotVersion: p.snapshotVersion, status: p.status },
          }),
        );
      }
    }

    // 12. reservation conflict：预占的资源当前离线/数据陈旧（预占不可用资源）。
    for (const r of state.reservations ?? []) {
      const offline =
        r.resourceType === 'device' &&
        state.devices.find((d) => d.id === r.resourceId)?.online === false;
      const stale =
        r.resourceType === 'person'
          ? state.persons.find((p) => p.id === r.resourceId)?.dataQuality !== 'FRESH'
          : r.resourceType === 'device'
            ? state.devices.find((d) => d.id === r.resourceId)?.dataQuality !== 'FRESH'
            : false;
      if (offline || stale) {
        conflicts.push(
          this.mkConflict(`reservation_conflict:${r.resourceType}:${r.resourceId}:${r.reservationId}`, {
            type: 'reservation_conflict',
            severity: 'high',
            scope: 'resource',
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            taskIds: [],
            message: `资源 ${r.resourceId}（${r.resourceType}）存在预占但当前不可用`,
            resolution: '释放该预占并改派可用资源',
            snapshotVersion: 'CURRENT',
            data: {
              reservationId: r.reservationId,
              startMs: r.startMs,
              endMs: r.endMs,
              offline,
              stale,
            },
          }),
        );
      }
    }

    // 13. reservation expiring：预占即将过期（剩余时长 < 阈值）。
    // 预警而非阻断：提示值班员提前续约/重排，避免派工执行中途资源失效。
    const expiringThresholdMs = this.reservationExpiringThresholdMs;
    for (const r of state.reservations ?? []) {
      if (r.endMs == null) continue;
      const remainingMs = r.endMs - now;
      if (remainingMs >= 0 && remainingMs < expiringThresholdMs) {
        conflicts.push(
          this.mkConflict(
            `reservation_expiring:${r.resourceType}:${r.resourceId}:${r.reservationId}`,
            {
              type: 'reservation_expiring',
              severity: 'medium',
              scope: 'resource',
              resourceType: r.resourceType,
              resourceId: r.resourceId,
              taskIds: [],
              message: `资源 ${r.resourceId}（${r.resourceType}）预占即将过期（剩余 ${Math.ceil(remainingMs / 60000)} 分钟）`,
              resolution: '续约预占或在过期前完成派工/重排',
              snapshotVersion: 'CURRENT',
              data: {
                reservationId: r.reservationId,
                startMs: r.startMs,
                endMs: r.endMs,
                remainingMs,
                thresholdMs: expiringThresholdMs,
              },
            },
          ),
        );
      }
    }

    // v0.7 B3：新冲突实时推送（SSE conflict.detected）。
    // 仅推送首次出现的 conflictId（内存去重），避免前端轮询触发的重复推送；
    // 冲突消失不推送（由前端轮询/快照兜底）。缺失 outboxService（测试）时静默跳过。
    this.emitNewConflicts(conflicts);

    return conflicts;
  }

  /** v0.7 B3：已推送过的冲突 id 缓存（防重复推送，有界）。 */
  private readonly emittedConflictIds = new Set<string>();
  private static readonly EMITTED_CONFLICT_CAP = 500;

  /**
   * v0.7 B3：将新出现的冲突通过 outbox 推送到 SSE 流（conflict.detected）。
   * 内存去重：同 conflictId（内容哈希稳定）只推送一次；缓存超上限时清空最老一半。
   * 幂等性由 sequence 机制 + 前端去重双保险。
   */
  private emitNewConflicts(conflicts: SchedulingConflict[]): void {
    if (!this.outboxService) return;
    for (const c of conflicts) {
      if (this.emittedConflictIds.has(c.conflictId)) continue;
      this.emittedConflictIds.add(c.conflictId);
      if (this.emittedConflictIds.size > SchedulerService.EMITTED_CONFLICT_CAP) {
        // 防无界增长：清空最老一半（近似）
        const drop = Math.floor(this.emittedConflictIds.size / 2);
        let i = 0;
        for (const id of this.emittedConflictIds) {
          if (i++ >= drop) break;
          this.emittedConflictIds.delete(id);
        }
      }
      Promise.resolve(
        this.outboxService.enqueue(
          'conflict.detected',
          c.conflictId,
          {
            conflictId: c.conflictId,
            type: c.type,
            severity: c.severity,
            scope: c.scope,
            resourceId: c.resourceId,
            resourceType: c.resourceType,
            taskIds: c.taskIds,
            message: c.message,
            resolution: c.resolution,
          },
          null,
        ),
      ).catch((e) => {
        this.logger.warn(`conflict.detected enqueue failed: ${(e as Error).message}`);
      });
    }
  }

  /** 构造统一冲突，conflictId 由内容种子哈希生成（跨查询稳定）。 */
  private mkConflict(
    seed: string,
    input: Omit<SchedulingConflict, 'conflictId' | 'createdAt'>,
  ): SchedulingConflict {
    return {
      conflictId: `CFL-${this.hash(seed)}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
  }

  /** djb2 字符串哈希（生成稳定冲突 id）。 */
  private hash(str: string): number {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  private toOrgContext(actor?: OrgContext): OrgContext {
    return {
      userId: actor?.userId ?? 'system',
      primaryOrgId: actor?.primaryOrgId ?? '',
      role: actor?.role,
      accessibleOrgIds:
        actor?.accessibleOrgIds ??
        (actor?.primaryOrgId ? [actor.primaryOrgId] : []),
      isGlobalAdmin: actor?.isGlobalAdmin ?? false,
    };
  }

  private mapRun(
    r: typeof ewohSchedulingRun.$inferSelect,
  ): SchedulingRun {
    return {
      runId: r.runId,
      triggerType: r.triggerType ?? 'MANUAL',
      triggerEntityId: r.triggerEntityId ?? null,
      status: (r.status ?? 'queued') as SchedulingRun['status'],
      snapshotVersion: r.snapshotVersion ?? null,
      planIds: (r.planIds as string[] | null) ?? [],
      orgId: r.orgId ?? null,
      error: r.error ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : '',
    };
  }

  private mapPlan(r: typeof ewohSchedulePlan.$inferSelect): SchedulePlan {
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

  private mapAudit(r: typeof ewohScheduleAudit.$inferSelect): ScheduleAudit {
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

  private randomSuffix(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }
}
