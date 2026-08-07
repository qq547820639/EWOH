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
} from '@server/database/schema';
import { eq, desc, and, sql, gte, inArray } from 'drizzle-orm';
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

/**
 * NOTE: ewoh_schedule_audit has no before_json/after_json columns in the
 * current DDL, so the before/after weight snapshots are persisted through
 * ewoh_audit_log via AuditService. The ewoh_schedule_audit row keeps the
 * action/operator/plan surface for API and query compatibility.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  private weights: ScheduleWeights = {
    w1_output: 0.25,
    w2_on_time: 0.2,
    w3_safety_risk: 0.2,
    w4_body_load: 0.15,
    w5_move_distance: 0.1,
    w6_changeover_cost: 0.1,
  };

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
    return {
      runId: row.runId,
      triggerType: row.triggerType ?? 'MANUAL',
      triggerEntityId: row.triggerEntityId ?? null,
      status: (row.status ?? 'queued') as SchedulingRun['status'],
      snapshotVersion: row.snapshotVersion ?? null,
      planIds: (row.planIds as string[] | null) ?? [],
      orgId: row.orgId ?? null,
      error: row.error ?? null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : '',
    };
  }

  async getPlanDetail(planId: string): Promise<SchedulingPlanV2> {
    return this.planService.getPlan(planId);
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
