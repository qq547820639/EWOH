import { Injectable, Inject, Optional, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ArkService } from '../ai/ark.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import {
  ewohDevice,
  ewohTelemetry,
  ewohEvent,
  ewohSpatialEntity,
  ewohSchedulePlan,
  ewohScheduleAudit,
} from '@server/database/schema';
import { eq, desc, and, sql, gte, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  PlayerRole,
  PlayerRoleInfo,
  ResourceAllocationRequest,
  ResourceAllocationResult,
  AllocationEvaluation,
  TaskOrchestrationRequest,
  TaskOrchestrationResult,
  TaktSimulation,
  ProcessNode,
  DispatchRequest,
  DispatchResult,
  ExoFeedbackRequest,
  ExoFeedbackResult,
  BrainSuggestion,
  ApplyBrainSuggestionRequest,
  ApplyBrainSuggestionResult,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { buildGucSettings } from '../shared/org-context.interceptor';
import { rethrowWithGuard, rethrowWithLog } from '../shared/rethrow-with-log';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { assertPlanTenantVisible } from '../scheduler/plan-tenant-guard';
import { markPlanDispatched } from '../scheduler/scheduling-plan.lifecycle';

/**
 * 游戏化玩法 + 具身智能服务（工厂即具身机器人）
 * G3.1 玩家角色 / G3.2 资源分配 / G3.3 任务编排
 * G3.5 调度下发 / G3.6 外骨骼反馈 / G3.7 大脑推理
 */
@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly ark?: ArkService,
    private readonly schedulerService?: SchedulerService,
    /** P1-GUC（2026-08-19 审计）：后台 LLM 增强重建租户 GUC 上下文用。 */
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
  ) {}

  // ===== G3.1 玩家角色系统 =====

  /**
   * NEST-351（2026-08-17 审计整改）：玩家角色从认证上下文推导（原先读
   * EWOH_PLAYER_ROLE 环境变量，全实例单角色——所有用户看到同一角色）。
   * RBAC 角色 → 指挥地图玩家角色映射：global_admin→厂长、
   * dispatcher/workshop_lead/safety_admin→车间主任、其余→班组长。
   */
  getRole(actor?: OrgContext): PlayerRoleInfo {
    const rbacRole =
      Array.isArray(actor?.roles) && actor!.roles!.length > 0
        ? actor!.roles![0]!
        : actor?.role ?? '';
    const playerName =
      actor?.userId ?? process.env.EWOH_PLAYER_NAME ?? '当前用户';

    let role: PlayerRole;
    if (rbacRole === 'global_admin') {
      role = 'factory_manager';
    } else if (
      rbacRole === 'dispatcher' ||
      rbacRole === 'workshop_lead' ||
      rbacRole === 'safety_admin'
    ) {
      role = 'workshop_director';
    } else {
      role = 'shift_leader';
    }

    const roleMap: Record<PlayerRole, { roleName: string; visibleLevels: string[]; permissions: string[] }> = {
      shift_leader: {
        roleName: '班组长',
        visibleLevels: ['L0', 'L1', 'L2'],
        permissions: ['view', 'allocate_resource', 'orchestrate_task', 'confirm_plan', 'handle_event'],
      },
      workshop_director: {
        roleName: '车间主任',
        visibleLevels: ['L0', 'L1', 'L2'],
        permissions: [
          'view',
          'allocate_resource',
          'orchestrate_task',
          'confirm_plan',
          'dispatch_plan',
          'handle_event',
          'exo_feedback',
        ],
      },
      factory_manager: {
        roleName: '厂长',
        visibleLevels: ['L0', 'L1', 'L2'],
        permissions: [
          'view',
          'allocate_resource',
          'orchestrate_task',
          'confirm_plan',
          'dispatch_plan',
          'handle_event',
          'exo_feedback',
          'adjust_weights',
          'manage_model',
        ],
      },
    };

    const info = roleMap[role];
    return {
      role,
      roleName: info.roleName,
      visibleLevels: info.visibleLevels,
      permissions: info.permissions,
      playerName,
    };
  }

  /**
   * NEST-330（2026-08-17 审计整改）：写路径强制租户上下文（原先
   * orgId ?? null 回退——NULL 行被所有租户可见）。global_admin 用其
   * primaryOrgId 归属（不再写 NULL 全局行）。
   */
  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: gamification write operations require tenant context',
      );
    }
    return orgId;
  }

  // ===== G3.2 资源分配 =====

  async allocateResources(
    req: ResourceAllocationRequest,
    actor?: OrgContext,
  ): Promise<ResourceAllocationResult> {
    try {
      if (!req.allocations || req.allocations.length === 0) {
        throw new BadRequestException('allocations is required');
      }
      const orgId = this.requireOrgId(actor);

      const operator = req.operator ?? 'supervisor';
      const planId = `ALLOC-${Date.now()}-${this.randomSuffix(4)}`;
      const allocationResults: ResourceAllocationResult['allocations'] = [];
      const conflicts: string[] = [];
      const suggestions: string[] = [];

      // 收集已分配人员/设备的 entity_id（用于负荷与电量评估）
      const allocatedEntityIds = req.allocations.map((a) => a.entityId);

      // 1. 冲突检测：人员离线（ewoh_device.device_id = entityId 且 online=false）
      // NEST-310：设备与实体查询带 org 谓词（防跨租户实体被改绑）。
      const deviceRows = allocatedEntityIds.length
        ? await this.db
            .select()
            .from(ewohDevice)
            .where(
              and(
                inArray(ewohDevice.deviceId, allocatedEntityIds),
                eq(ewohDevice.orgId, orgId),
              ),
            )
        : [];

      const offlineSet = new Set(deviceRows.filter((d) => d.online === false).map((d) => d.deviceId));
      const batteryByDevice = new Map<string, number>(
        deviceRows.map((d) => [d.deviceId, d.batteryPct ?? 100]),
      );

      // 2. 加载已分配人员最近 1h 的平均负荷（按 deviceId 聚合；org 过滤）
      const loadRows = allocatedEntityIds.length
        ? await this.db
            .select({
              deviceId: ewohTelemetry.deviceId,
              avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
            })
            .from(ewohTelemetry)
            .where(
              and(
                inArray(ewohTelemetry.deviceId, allocatedEntityIds),
                eq(ewohTelemetry.orgId, orgId),
                gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
              ),
            )
            .groupBy(ewohTelemetry.deviceId)
        : [];
      const loadByDevice = new Map<string, number>(loadRows.map((r) => [r.deviceId, r.avgLoad ?? 0]));

      // 3. 逐条执行分配（更新 ewoh_spatial_entity.parent_id = targetId；
      //    NEST-310：update where 带 org 谓词，跨租户实体 0 行命中=失败留痕）。
      for (const alloc of req.allocations) {
        if (offlineSet.has(alloc.entityId)) {
          conflicts.push(`实体 ${alloc.entityId} 关联设备离线，无法分配`);
          allocationResults.push({
            entityId: alloc.entityId,
            targetId: alloc.targetId,
            success: false,
            error: '设备离线',
          });
          continue;
        }
        try {
          const updated = await this.db
            .update(ewohSpatialEntity)
            .set({ parentId: alloc.targetId })
            .where(
              and(
                eq(ewohSpatialEntity.entityId, alloc.entityId),
                eq(ewohSpatialEntity.orgId, orgId),
              ),
            )
            .returning({ entityId: ewohSpatialEntity.entityId });
          if (!updated || updated.length === 0) {
            throw new Error('实体不存在或非本租户');
          }
          allocationResults.push({
            entityId: alloc.entityId,
            targetId: alloc.targetId,
            success: true,
          });
        } catch (err) {
          this.logger.error(`分配失败 entityId=${alloc.entityId}`, err);
          allocationResults.push({
            entityId: alloc.entityId,
            targetId: alloc.targetId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 4. 评估指标
      const loadScores = req.allocations
        .map((a) => loadByDevice.get(a.entityId))
        .filter((v): v is number => typeof v === 'number');
      const loadBalance = this.computeStdDevNormalized(loadScores); // 0-1，越高越均衡
      // NEST-352：无技能数据 → null（显式 unknown，不伪造 0.8）。
      const skillMatch: number | null = null;

      const batteryValues = req.allocations
        .map((a) => batteryByDevice.get(a.entityId))
        .filter((v): v is number => typeof v === 'number');
      const batteryEndurance =
        batteryValues.length > 0
          ? Number((batteryValues.reduce((s, v) => s + v, 0) / batteryValues.length / 100).toFixed(3))
          : 0.8;

      if (loadBalance < 0.6) {
        suggestions.push('负荷均衡度偏低，建议将高负荷人员任务部分转移给低负荷人员');
      }
      if (batteryEndurance < 0.3) {
        suggestions.push('整体电量续航不足，建议优先安排换电或充电');
      }
      if (conflicts.length > 0) {
        suggestions.push('存在离线冲突，请先恢复设备在线状态后再分配');
      }

      const overall: AllocationEvaluation['overall'] =
        conflicts.length > 0 || loadBalance < 0.4 || batteryEndurance < 0.2
          ? 'red'
          : loadBalance < 0.7 || batteryEndurance < 0.4
            ? 'yellow'
            : 'green';

      const evaluation: AllocationEvaluation = {
        overall,
        loadBalance: Number(loadBalance.toFixed(3)),
        skillMatch,
        batteryEndurance,
        conflicts,
        suggestions,
      };

      // 5. 写入 ewoh_schedule_plan（strategy='resource_alloc', status='proposed'）
      const now = new Date();
      await this.db.insert(ewohSchedulePlan).values({
        planId,
        planName: `资源分配-${planId}`,
        strategy: 'resource_alloc',
        status: 'proposed',
        taktImprovement: 0,
        highLoadPersons: loadScores.filter((v) => v > 0.7).length,
        lowBatteryRisk: batteryValues.filter((v) => v < 20).length,
        affectedPersons: req.allocations.length,
        metricsJson: {
          allocatedEntities: allocatedEntityIds,
          loadBalance: Number(loadBalance.toFixed(3)),
          skillMatch,
          batteryEndurance,
          overall,
          conflicts,
        } as Record<string, unknown>,
        reason: req.reason ?? `资源分配 ${req.allocations.length} 项，综合评估 ${overall}`,
        // NEST-330：方案行显式租户归属（不再回退 NULL 全局可见行）。
        orgId,
        createdAt: now,
      });

      // 6. 写入审计 action='allocate'
      const [auditRow] = await this.db
        .insert(ewohScheduleAudit)
        .values({
          auditId: `AUDIT-${Date.now()}-${this.randomSuffix(4)}`,
          planId,
          action: 'allocate',
          operator,
          reason: req.reason ?? `资源分配 ${req.allocations.length} 项`,
          createdAt: now,
          // NEST-330：audit 行显式归属（不再回退 NULL）。
          orgId,
        })
        .returning();

      this.logger.log(
        `allocateResources planId=${planId} overall=${overall} conflicts=${conflicts.length} auditId=${auditRow.auditId}`,
      );

      return {
        planId,
        evaluation,
        allocations: allocationResults,
      };
    } catch (error) {
      rethrowWithGuard(this.logger, 'allocateResources 失败', error, BadRequestException);
    }
  }

  // ===== G3.3 任务编排 =====

  async orchestrateTask(
    req: TaskOrchestrationRequest,
    actor?: OrgContext,
  ): Promise<TaskOrchestrationResult> {
    try {
      if (!req.nodes || req.nodes.length === 0) {
        throw new BadRequestException('nodes is required');
      }

      const operator = req.operator ?? 'supervisor';
      const planId = `ORCH-${Date.now()}-${this.randomSuffix(4)}`;
      const now = new Date();
      // NEST-330：编排写路径强制租户上下文。
      const orgId = this.requireOrgId(actor);

      // 1. 查询已分配工位最近 1h 平均占用，作为节拍推算依据（数据驱动，而非随机）
      const workstationIds = req.nodes
        .map((n) => n.assignedWorkstationId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      const occupancyByWs = new Map<string, number>();
      if (workstationIds.length > 0) {
        const occRows = await this.db
          .select({
            entityId: ewohSpatialEntity.entityId,
            avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
          })
          .from(ewohTelemetry)
          .innerJoin(
            ewohSpatialEntity,
            eq(ewohSpatialEntity.entityId, ewohTelemetry.deviceId),
          )
          .where(
            and(
              inArray(ewohSpatialEntity.entityId, workstationIds),
              // R2-SBZ-005/R2-SAM-004：占用聚合 join 两侧表均补 org 谓词——
              // 他租户同 ID 空间实体的遥测负荷不再进入本租户节拍推算（takt 污染）。
              eq(ewohSpatialEntity.orgId, orgId),
              eq(ewohTelemetry.orgId, orgId),
              gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
            ),
          )
          .groupBy(ewohSpatialEntity.entityId);
        for (const r of occRows) occupancyByWs.set(r.entityId, r.avgLoad ?? 0);
      }

      // 1. 节拍模拟：按工位实时占用推算 takt（占用越高节拍越慢），无数据时回退默认 30s
      //    节拍基准 30s，占用每提升 0.1 增加 3s，封顶 60s。
      const nodes: ProcessNode[] = req.nodes.map((n) => {
        let takt = n.estimatedTakt;
        let source: 'telemetry' | 'default' = 'default';
        if (takt == null && n.assignedWorkstationId) {
          const occ = occupancyByWs.get(n.assignedWorkstationId);
          if (occ != null) {
            takt = Number(Math.min(30 + occ * 30, 60).toFixed(2));
            source = 'telemetry';
          }
        }
        if (takt == null) takt = 30;
        // 回传节拍数据来源，供前端标注「真实遥测 / 默认值」，提升演示可信度
        return { ...n, estimatedTakt: takt, taktSource: source } as ProcessNode;
      });

      const stationTakts: TaktSimulation['stationTakts'] = [];
      const stationNameMap = new Map<string, string>();

      // 查询工位名称（复用上方已求值的 workstationIds）
      if (workstationIds.length > 0) {
        const wsRows = await this.db
          .select({ entityId: ewohSpatialEntity.entityId, name: ewohSpatialEntity.name })
          .from(ewohSpatialEntity)
          .where(
            and(
              inArray(ewohSpatialEntity.entityId, workstationIds),
              // R2-SBZ-005/R2-SAM-004：工位名称查询补 org 谓词——
              // 不回显他租户实体名（污染 TaktSimulation 与 metricsJson 落库）。
              eq(ewohSpatialEntity.orgId, orgId),
            ),
          );
        for (const r of wsRows) stationNameMap.set(r.entityId, r.name);
      }

      let bottleneckTakt = 0;
      let bottleneckNodeId: string | null = null;
      let sumTakt = 0;

      for (const node of nodes) {
        const takt = node.estimatedTakt ?? 30;
        sumTakt += takt;
        if (takt > bottleneckTakt) {
          bottleneckTakt = takt;
          bottleneckNodeId = node.nodeId;
        }
        if (node.assignedWorkstationId) {
          stationTakts.push({
            workstationId: node.assignedWorkstationId,
            workstationName: stationNameMap.get(node.assignedWorkstationId) ?? node.assignedWorkstationId,
            taktSec: Number(takt.toFixed(2)),
            isBottleneck: false,
            taktSource: node.taktSource ?? 'default',
          });
        }
      }

      // 标记瓶颈工位
      const bottleneckWorkstationId =
        stationTakts.length > 0
          ? stationTakts.reduce((max, cur) => (cur.taktSec > max.taktSec ? cur : max), stationTakts[0])
              .workstationId
          : null;
      for (const s of stationTakts) {
        s.isBottleneck = s.workstationId === bottleneckWorkstationId;
      }

      const bottleneckWorkstationName = bottleneckWorkstationId
        ? stationNameMap.get(bottleneckWorkstationId) ?? bottleneckWorkstationId
        : null;

      // 顺序执行：预计完成时间 = 各工位节拍之和；每小时产量 = 3600 / 瓶颈节拍
      const estimatedCompletionSec = Number(sumTakt.toFixed(2));
      const throughputPerHour = bottleneckTakt > 0 ? Number((3600 / bottleneckTakt).toFixed(2)) : 0;

      const simulation: TaktSimulation = {
        bottleneckWorkstationId,
        bottleneckWorkstationName,
        estimatedCompletionSec,
        throughputPerHour,
        stationTakts,
      };

      // 2. 写入 ewoh_schedule_plan（strategy='task_orchest', status='proposed'）
      const assignedEntities = nodes
        .map((n) => n.assignedPersonId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      await this.db.insert(ewohSchedulePlan).values({
        planId,
        planName: `任务编排-${req.orderId}`,
        strategy: 'task_orchest',
        status: 'proposed',
        taktImprovement: 0,
        highLoadPersons: 0,
        lowBatteryRisk: 0,
        affectedPersons: assignedEntities.length,
        metricsJson: {
          takt: Number(bottleneckTakt.toFixed(2)),
          bottleneck: bottleneckWorkstationId,
          completion_sec: estimatedCompletionSec,
          throughput: throughputPerHour,
          orderId: req.orderId,
          assignedEntities,
        } as Record<string, unknown>,
        reason: `工单 ${req.orderId} 编排 ${nodes.length} 道工序，瓶颈节拍 ${bottleneckTakt.toFixed(1)}s，预计完成 ${estimatedCompletionSec}s`,
        // NEST-330：方案行显式租户归属。
        orgId,
        createdAt: now,
      });

      // 3. 写入审计 action='orchestrate'
      const [auditRow] = await this.db
        .insert(ewohScheduleAudit)
        .values({
          auditId: `AUDIT-${Date.now()}-${this.randomSuffix(4)}`,
          planId,
          action: 'orchestrate',
          operator,
          reason: `工单 ${req.orderId} 任务编排`,
          // NEST-330：audit 行显式归属。
          orgId,
          createdAt: now,
        })
        .returning();

      this.logger.log(
        `orchestrateTask planId=${planId} orderId=${req.orderId} bottleneck=${bottleneckWorkstationId} takt=${bottleneckTakt.toFixed(1)} throughput=${throughputPerHour} auditId=${auditRow.auditId}`,
      );

      return {
        planId,
        simulation,
        nodes,
      };
    } catch (error) {
      rethrowWithGuard(this.logger, 'orchestrateTask 失败', error, BadRequestException);
    }
  }

  // ===== G3.5 调度下发 =====

  /**
   * T4 完整收敛（2026-08-29，待拍板决策单·决策项 1 裁决 B：委托反转）。
   *
   * 本端点是旁路契约（POST /api/gamification/schedule/:planId/dispatch），历史上
   * 与正统派工（scheduler.controller → dispatchPlanV2）双实现并存。按决策单推荐
   * B：保留端点与契约（零 breaking），内部按方案所在轨道分派：
   *
   * - `approved`（V2 正统轨道）→ 完整委托 SchedulerService.dispatchPlanV2：获得
   *   快照新鲜度校验、安全事件熔断、资源预约（EXCLUDE/advisory lock）、Execution
   *   建档与 audit_log 审计的全套正统机制——消除"approved 方案经旁路只得到 400"
   *   的行为分叉。此分支回写一条 ewoh_schedule_audit（正统审计在 audit_log hash
   *   链，两审计表面向不同契约承诺，并存不重复）以兑现旁路契约的 auditId。
   * - `confirmed`（legacy confirm 轨道）→ 保留既有薄路径：该轨道方案不持有
   *   ewoh_scheduling_plan_assignment 明细与 snapshotVersion，无法安全进入 V2
   *   派工机制（派工将变成空分配）；confirmed→approved 状态提升等于伪造审批，
   *   属治理违规。此轨道即决策单 C（硬删）的观察期对象，废弃告警日志供网关
   *   流量核对。
   */
  async dispatchPlan(
    planId: string,
    req: DispatchRequest,
    actor?: OrgContext,
  ): Promise<DispatchResult> {
    try {
      // 0. 载入 + 租户守卫（ADR-071/NO-13v：先守卫后业务校验，反枚举 404）。
      const [existing] = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(eq(ewohSchedulePlan.planId, planId))
        .limit(1);

      if (!existing) {
        throw new NotFoundException(`Schedule plan ${planId} not found`);
      }
      assertPlanTenantVisible(existing.orgId, actor, planId);

      // 1. V2 正统轨道：完整委托（决策项 1 裁决 B 的核心收益面）。
      if (existing.status === 'approved' && this.schedulerService) {
        return await this.dispatchViaOrthodox(planId, req, actor, existing);
      }

      if (existing.status !== 'confirmed') {
        throw new BadRequestException(`Schedule plan ${planId} is not confirmed (current: ${existing.status})`);
      }
      this.logger.warn(
        `[DEPRECATED] legacy confirm-track dispatch via gamification bypass: planId=${planId} (决策项 1 观察期；硬删前需网关日志确认零调用)`,
      );
      return await this.dispatchConfirmedLegacy(planId, req, actor, existing);
    } catch (error) {
      rethrowWithGuard(
        this.logger,
        'dispatchPlan 失败',
        error,
        BadRequestException,
        NotFoundException,
      );
    }
  }

  /** T4：V2 正统轨道委托 + 旁路契约形状适配（语义见 dispatchPlan 注释）。 */
  private async dispatchViaOrthodox(
    planId: string,
    req: DispatchRequest,
    actor: OrgContext | undefined,
    existing: typeof ewohSchedulePlan.$inferSelect,
  ): Promise<DispatchResult> {
    const now = new Date();
    // 正统机制全量执行（预约/安全熔断/新鲜度/Execution/出站事件）。
    // 失败（SHADOW_PLAN_GUARD/PLAN_CONCURRENT_DISPATCH 等）原样上抛——
    // 旁路调用方与正统调用方看到同一错误语义。
    await this.schedulerService!.dispatchPlanV2(planId, actor);

    // 旁路契约 auditId 兑现：legacy 审计面留痕（action='dispatch'），reason
    // 注明委托语义；正统审计走 auditService（audit_log hash 链）不在此重复。
    const [auditRow] = await this.db
      .insert(ewohScheduleAudit)
      .values({
        auditId: `AUDIT-${Date.now()}-${this.randomSuffix(4)}`,
        planId,
        action: 'dispatch',
        operator: req.operator ?? 'dispatcher',
        reason: req.executionNote ?? `方案下发执行（T4 委托 dispatchPlanV2）`,
        createdAt: now,
        orgId: actor?.primaryOrgId ?? existing.orgId,
      })
      .returning();

    this.logger.log(`dispatchPlan planId=${planId} dispatched via dispatchPlanV2 auditId=${auditRow.auditId}`);
    return {
      planId,
      status: 'dispatched',
      conflicts: [],
      dispatchedAt: now.toISOString(),
      auditId: auditRow.auditId,
    };
  }

  /** T4：legacy confirm 轨道薄路径（原实现收敛为私有方法，行为不变）。 */
  private async dispatchConfirmedLegacy(
    planId: string,
    req: DispatchRequest,
    actor: OrgContext | undefined,
    existing: typeof ewohSchedulePlan.$inferSelect,
  ): Promise<DispatchResult> {
    const operator = req.operator ?? 'dispatcher';
    const now = new Date();

    // 冲突检测：从 metricsJson 提取关联实体/设备，检查是否离线
    const metrics = (existing.metricsJson as Record<string, unknown> | null) ?? {};
    const entityIds = this.extractEntityIds(metrics);

    let conflicts: string[] = [];
    if (entityIds.length > 0) {
      // NEST-309 配套：冲突检测设备查询带 org 过滤（跨租户设备不进冲突判定）。
      const dispatchOrgCond = actor?.isGlobalAdmin
        ? undefined
        : eq(ewohDevice.orgId, this.requireOrgId(actor));
      const deviceRows = await this.db
        .select({ deviceId: ewohDevice.deviceId, online: ewohDevice.online, workerName: ewohDevice.workerName })
        .from(ewohDevice)
        .where(
          dispatchOrgCond
            ? and(inArray(ewohDevice.deviceId, entityIds), dispatchOrgCond)
            : inArray(ewohDevice.deviceId, entityIds),
        );
      conflicts = deviceRows
        .filter((d) => d.online === false)
        .map((d) => `设备 ${d.workerName ?? d.deviceId} 离线，无法下发`);
    }

    // 写入审计 action='dispatch'
    const [auditRow] = await this.db
      .insert(ewohScheduleAudit)
      .values({
        auditId: `AUDIT-${Date.now()}-${this.randomSuffix(4)}`,
        planId,
        action: 'dispatch',
        operator,
        reason:
          conflicts.length > 0
            ? `下发冲突：${conflicts.join('; ')}`
            : req.executionNote ?? `方案下发执行`,
        createdAt: now,
        // NEST-330（2026-08-28 闭合）：audit 行显式归属。schedule_plan.org_id
        // 自 057 起 NOT NULL，去掉 null 回退（残留会写出无归属审计行）。
        orgId: actor?.primaryOrgId ?? existing.orgId,
      })
      .returning();

    if (conflicts.length > 0) {
      // 存在冲突，保持已确认状态，返回 conflict
      this.logger.warn(`dispatchPlan planId=${planId} conflict: ${conflicts.length} issues`);
      return {
        planId,
        status: 'conflict',
        conflicts,
        dispatchedAt: now.toISOString(),
        auditId: auditRow.auditId,
      };
    }

    // 无冲突，更新方案状态为 'dispatched'
    // T4 加固（2026-08-28，审计 R2-SBZ-014 闭合）：补 status CAS——
    // 读-改-写窗口内并发 double-dispatch 时后到者 0 行命中 → 409，
    // 与 plan.service dispatchPlanV2 的 approved→dispatched CAS 语义对齐。
    // V79：CAS 本身收进 `markPlanDispatched`（与正统派工共用唯一写入口），
    // 本轨道的前置状态仍是 confirmed，对外 409 文案不变。
    const dispatched = await markPlanDispatched(this.db, {
      planId,
      fromStatus: 'confirmed',
    });
    if (!dispatched) {
      throw new ConflictException(
        `Schedule plan ${planId} concurrently dispatched or no longer confirmed`,
      );
    }

    this.logger.log(`dispatchPlan planId=${planId} dispatched auditId=${auditRow.auditId}`);

    return {
      planId,
      status: 'dispatched',
      conflicts: [],
      dispatchedAt: now.toISOString(),
      auditId: auditRow.auditId,
    };
  }

  // ===== G3.6 外骨骼反馈 =====

  async sendExoFeedback(
    deviceId: string,
    req: ExoFeedbackRequest,
    actor?: OrgContext,
  ): Promise<ExoFeedbackResult> {
    try {
      // NEST-311：设备按 (orgId, deviceId) 定位——跨租户设备不可注入反馈。
      const orgId = this.requireOrgId(actor);
      // 1. 校验设备存在（本租户）
      const [device] = await this.db
        .select()
        .from(ewohDevice)
        .where(and(eq(ewohDevice.deviceId, deviceId), eq(ewohDevice.orgId, orgId)))
        .limit(1);

      if (!device) {
        return {
          deviceId,
          accepted: false,
          delivered: false,
          error: '设备不存在',
        };
      }

      // 2. 校验在线状态
      if (device.online !== true) {
        return {
          deviceId,
          accepted: false,
          delivered: false,
          error: '设备离线',
        };
      }

      // 3. 写入事件 ewoh_event（NEST-311：显式 orgId）
      const priority = req.priority ?? 'normal';
      // B7（2026-08-19 审计）：事件严重度统一 canonical（原 legacy L1-L3 映射，
      // 与 ingest/ERP 等模块的 canonical 词表分裂 → 安全封锁/优先级加权失配）。
      const severity = priority === 'critical' || priority === 'high' ? priority : 'low';
      const title = `外骨骼反馈-${req.type}${req.message ? `: ${req.message}` : ''}`;
      const now = new Date();

      await this.db.insert(ewohEvent).values({
        eventId: `EVT-${Date.now()}-${this.randomSuffix(6)}`,
        deviceId,
        eventCode: 'EXO_FEEDBACK',
        eventType: 'feedback',
        severity,
        title,
        status: 'open',
        createdAt: now,
        sourceType: 'simulated',
        orgId,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        evidenceJson: {
          type: req.type,
          tactilePattern: req.tactilePattern ?? null,
          message: req.message ?? null,
          arContent: req.arContent ?? null,
          priority,
          reason: req.reason ?? null,
        } as Record<string, unknown>,
      });

      this.logger.log(`sendExoFeedback deviceId=${deviceId} type=${req.type} priority=${priority} delivered`);

      return {
        deviceId,
        accepted: true,
        delivered: true,
      };
    } catch (error) {
      rethrowWithLog(this.logger, 'sendExoFeedback 失败', error);
    }
  }

  // ===== G3.7 大脑推理建议 =====

  /**
   * LLM 增强结果的进程内缓存：先返回规则建议，LLM 异步增强后回写覆盖。
   * NEST-308（2026-08-17 审计整改）：缓存按 org 分桶（原先单实例变量——
   * A 租户的 LLM 增强结果会被 B 租户读到，跨租户建议泄漏）。
   */
  private readonly brainCacheByOrg = new Map<
    string,
    { suggestions: BrainSuggestion[]; cachedAt: number }
  >();
  /** 各 org 是否有后台 LLM 增强正在执行（供前端展示「增强中」状态）。 */
  private readonly brainEnhancingOrgs = new Set<string>();

  /**
   * 大脑建议（G3.7）。
   * 设计：同步返回规则建议（毫秒级），LLM 增强在后台异步执行并写入缓存，
   * 后续轮询（前端每 10s）命中缓存后返回增强结果。
   * 返回前会为建议回填已存在的可审批方案 planId，打通「采纳 → 定位方案」闭环。
   */
  async getBrainSuggestions(actor?: OrgContext): Promise<BrainSuggestion[]> {
    try {
      const orgId = this.requireOrgId(actor);
      // 1. 先构造规则建议（毫秒级，不依赖 LLM；NEST-309：聚合带 org 过滤）
      const suggestions = await this.buildRuleSuggestions(actor);

      // 2. 若已有较新的 LLM 增强缓存（本 org 桶），直接返回增强结果
      const cacheTtlMs = 10 * 60 * 1000;
      const cached = this.brainCacheByOrg.get(orgId);
      if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
        this.logger.log(
          `getBrainSuggestions serving ${cached.suggestions.length} cached (LLM) suggestions (org=${orgId})`,
        );
        return this.attachPlanIds(cached.suggestions, actor);
      }

      // 3. 返回规则建议，同时后台异步触发 LLM 增强并回写缓存（本 org 桶）
      void this.enrichBrainSuggestionsWithLlmAsync(actor, suggestions);

      this.logger.log(`getBrainSuggestions returned ${suggestions.length} rule suggestions`);
      return this.attachPlanIds(
        suggestions.map((s) => ({ ...s, enhancing: this.brainEnhancingOrgs.has(orgId) })),
        actor,
      );
    } catch (error) {
      rethrowWithLog(this.logger, 'getBrainSuggestions 失败', error);
    }
  }

  /**
   * 为建议回填已存在的可审批（proposed/confirmed）方案 planId。
   * 按建议类型映射到对应调度策略，取最近一条同策略方案关联。
   */
  private async attachPlanIds(
    suggestions: BrainSuggestion[],
    actor?: OrgContext,
  ): Promise<BrainSuggestion[]> {
    if (suggestions.length === 0) return suggestions;
    try {
      const strategyByType = this.brainStrategyMap();
      const strategies = Array.from(
        new Set(suggestions.map((s) => strategyByType[s.type]).filter(Boolean)),
      );
      if (strategies.length === 0) return suggestions;

      const conditions = [
        inArray(ewohSchedulePlan.strategy, strategies),
        inArray(ewohSchedulePlan.status, ['proposed', 'confirmed']),
      ];
      // NEST-330：建议关联方案只读本租户（global_admin 放行；不再
      // or(isNull(orgId)) 放行 NULL 存量行——NULL 行对所有租户可见）。
      if (!actor?.isGlobalAdmin) {
        conditions.push(eq(ewohSchedulePlan.orgId, this.requireOrgId(actor)));
      }
      const rows = await this.db
        .select({
          planId: ewohSchedulePlan.planId,
          strategy: ewohSchedulePlan.strategy,
          status: ewohSchedulePlan.status,
        })
        .from(ewohSchedulePlan)
        .where(and(...conditions))
        .orderBy(desc(ewohSchedulePlan.createdAt));

      const latestByStrategy = new Map<string, string>();
      for (const r of rows) {
        if (!latestByStrategy.has(r.strategy)) latestByStrategy.set(r.strategy, r.planId);
      }

      return suggestions.map((s) => {
        const planId = latestByStrategy.get(strategyByType[s.type]);
        return planId ? { ...s, planId } : s;
      });
    } catch (error) {
      this.logger.warn(`attachPlanIds 失败：${String(error)}`);
      return suggestions;
    }
  }

  /** 建议类型 → 调度策略 映射（用于回填 planId 与「采纳」转化） */
  private brainStrategyMap(): Record<BrainSuggestion['type'], string> {
    return {
      load_balance: 'load_balance',
      battery_swap: 'battery_swap',
      takt_improve: 'capacity_priority',
      safety_intervene: 'safety_intervene',
      bottleneck_resolve: 'capacity_priority',
    };
  }

  /**
   * 大脑建议「采纳」：将一条规则/LLM 建议落库为一条 proposed 调度方案，
   * 返回 planId 供前端定位到调度面板，打通建议 → 审批闭环。
   */
  async applyBrainSuggestion(
    body: ApplyBrainSuggestionRequest,
    actor?: OrgContext,
  ): Promise<ApplyBrainSuggestionResult> {
    const operator = body.operator ?? 'supervisor';
    const strategy = this.brainStrategyMap()[body.type] ?? 'load_balance';
    const planName = `大脑建议-${(body.title || body.type).slice(0, 20)}`;

    // R2-SBZ-006：调度 run/plan 生成必须携带租户上下文——requireOrgId 前置
    // fail-closed（actor 缺失在触发调度前拒绝，而非仅在审计行写入时兜底）。
    const orgId = this.requireOrgId(actor);

    // 通过 Scheduling V2 内核生成 run + plan（Task 3.3：不再把方案直写 legacy 表、绕过 Scheduler）。
    if (!this.schedulerService) {
      throw new BadRequestException('调度内核不可用，无法采纳大脑建议');
    }
    // R2-SBZ-006：createRun 透传 actor（org 上下文）——run/plan 生成不再走
    // 系统全局上下文，world state 采集与 plan 归属均按调用方租户作用。
    const { run, plans, debounced } = await this.schedulerService.createRun(
      {
        trigger: 'MANUAL',
        entityId: body.type ? `brain:${body.type}` : undefined,
        reason: body.title,
      },
      actor,
    );
    if (debounced || !run || plans.length === 0) {
      this.logger.warn(
        `applyBrainSuggestion 触发被去抖合并（type=${body.type}），未生成新方案`,
      );
      throw new BadRequestException('调度已在进行中，请稍后再试');
    }
    const plan = plans[0];
    // R2-SBZ-006：plan 显式归属与调用方租户不一致即拒绝（跨租户归属分裂
    // fail-closed；undefined 仅 standalone_025 存量/全局过渡行语义放行）。
    if (plan.orgId != null && plan.orgId !== orgId) {
      throw new BadRequestException(
        `plan_tenant_mismatch: planId=${plan.planId} planOrgId=${plan.orgId} actorOrgId=${orgId}`,
      );
    }
    const planId = plan.planId;

    await this.db.insert(ewohScheduleAudit).values({
      auditId: `AUDIT-${Date.now()}-${this.randomSuffix(4)}`,
      planId,
      action: 'brain_apply',
      operator,
      reason: `采纳大脑建议：${body.title}`,
      createdAt: new Date(),
      // NEST-330：audit 行显式归属（不回退 NULL）。
      orgId,
    });

    this.logger.log(`applyBrainSuggestion planId=${planId} strategy=${strategy} operator=${operator}`);
    return { planId, planName, strategy, status: plan.status };
  }

  /** 基于实时数据构造规则建议（不调用 LLM）。NEST-309：聚合查询带 org 过滤。 */
  private async buildRuleSuggestions(actor?: OrgContext): Promise<BrainSuggestion[]> {
    const orgId = this.requireOrgId(actor);
    // 1. 查询最近 1h 遥测：按 deviceId 分组的平均负荷
    const telemetryRows = await this.db
      .select({
        deviceId: ewohTelemetry.deviceId,
        avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
        avgBattery: sql<number>`coalesce(avg(${ewohTelemetry.batteryPct}), 100)::float`,
      })
      .from(ewohTelemetry)
      .where(
        and(
          eq(ewohTelemetry.orgId, orgId),
          gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
        ),
      )
      .groupBy(ewohTelemetry.deviceId);

    // 2. 查询未结事件
    const openEvents = await this.db
      .select()
      .from(ewohEvent)
      .where(and(eq(ewohEvent.status, 'open'), eq(ewohEvent.orgId, orgId)));

    // 3. 查询低电量设备
    const lowBatteryDevices = await this.db
      .select({ deviceId: ewohDevice.deviceId, workerName: ewohDevice.workerName, batteryPct: ewohDevice.batteryPct })
      .from(ewohDevice)
      .where(and(sql`${ewohDevice.batteryPct} < 20`, eq(ewohDevice.orgId, orgId)));

    const suggestions: BrainSuggestion[] = [];

    const highLoadDevices = telemetryRows.filter((r) => (r.avgLoad ?? 0) > 0.7);
    const overloadDevices = telemetryRows.filter((r) => (r.avgLoad ?? 0) > 0.8);
    const criticalEvents = openEvents.filter((e) => e.severity === 'critical');

    // 建议 1: 负荷均衡（avg load > 0.8）
    if (overloadDevices.length > 0) {
      const maxLoad = Math.max(...overloadDevices.map((r) => r.avgLoad ?? 0));
      const confidence = Number(Math.min(0.6 + (maxLoad - 0.8) * 2, 0.95).toFixed(2));
      suggestions.push({
        type: 'load_balance',
        title: '高负荷人员负荷均衡',
        description: `检测到 ${overloadDevices.length} 台设备平均负荷超过 0.8，建议将高负荷人员任务部分转移给低负荷人员。`,
        affectedEntities: overloadDevices.map((r) => r.deviceId),
        expectedBenefit: `预计平均负荷下降 15-20%，最大负荷由 ${maxLoad.toFixed(2)} 降至 0.7 以下`,
        confidence,
      });
    }

    // 建议 2: 换电（battery < 20）
    if (lowBatteryDevices.length > 0) {
      const minBattery = Math.min(...lowBatteryDevices.map((d) => d.batteryPct ?? 100));
      const confidence = Number(Math.min(0.7 + (20 - minBattery) / 40, 0.95).toFixed(2));
      suggestions.push({
        type: 'battery_swap',
        title: '低电量设备换电',
        description: `检测到 ${lowBatteryDevices.length} 台设备电量低于 20%，建议立即安排换电或充电。`,
        affectedEntities: lowBatteryDevices.map((d) => d.deviceId),
        expectedBenefit: `避免设备停机，最低电量 ${minBattery}%，换电后可持续作业 4 小时`,
        confidence,
      });
    }

    // 建议 3: 安全介入（L3 事件）
    if (criticalEvents.length > 0) {
      suggestions.push({
        type: 'safety_intervene',
        title: 'L3 安全事件介入',
        description: `检测到 ${criticalEvents.length} 项 L3 级未结安全事件，建议立即介入处理。`,
        affectedEntities: criticalEvents.map((e) => e.eventId),
        expectedBenefit: '及时处置可避免安全事故升级，降低人员受伤风险',
        confidence: 0.9,
      });
    }

    // 建议 4: 节拍优化（高负荷设备 > 0）
    if (highLoadDevices.length > 0) {
      const confidence = Number((0.65 + Math.min(highLoadDevices.length * 0.05, 0.25)).toFixed(2));
      suggestions.push({
        type: 'takt_improve',
        title: '瓶颈工位节拍优化',
        description: `${highLoadDevices.length} 台设备处于高负荷状态，可能存在瓶颈工位，建议优化工序分配。`,
        affectedEntities: highLoadDevices.map((r) => r.deviceId),
        expectedBenefit: '通过瓶颈工位拆分或并行化，预计节拍提升 5-10%',
        confidence,
      });
    }

    // 建议 5: 无问题时给出通用优化建议
    if (suggestions.length === 0) {
      suggestions.push({
        type: 'bottleneck_resolve',
        title: '产线瓶颈通用优化',
        description: '当前各项指标平稳，建议持续监控并识别潜在瓶颈工位进行预防性优化。',
        affectedEntities: [],
        expectedBenefit: '预防性优化可提升整体产线稳定性，预计节拍提升 2-3%',
        confidence: 0.5,
      });
    }

    // 为规则建议补充稳定标识，供「采纳」时定位/转化
    return suggestions.map((s, i) => ({
      ...s,
      suggestionId: `SUG-${s.type}-${i}`,
    }));
  }

  /**
   * 后台异步执行 LLM 增强，成功后回写缓存（失败不影响已返回的规则建议；
   * NEST-308/309：按 org 分桶 + 聚合查询带 org 过滤）。
   *
   * P1-GUC（2026-08-19 审计）：本方法经 `void` fire-and-forget 调用——请求
   * 返回后 AsyncLocalStorage 事务 store 已释放，`this.db` 回落根句柄且无
   * GUC（app.current_org_ids 空 → ewoh_org_visible 恒 false）→ RLS 下
   * telemetry/event/device 查询**静默读空**，LLM 拿到空数据生成空增强。
   * 修复：以调用时刻捕获的 actor 在 runInTransaction 中重建租户 GUC 上下文
   * 再执行全部查询（与请求路径同语义；查询自身仍带显式 org WHERE 双保险）。
   */
  private async enrichBrainSuggestionsWithLlmAsync(
    actor: OrgContext | undefined,
    fallback: BrainSuggestion[],
  ): Promise<void> {
    const orgId = this.requireOrgId(actor);
    // 竞态守卫：该 org 已有增强在执行时直接跳过，避免前端每次轮询重复触发
    if (this.brainEnhancingOrgs.has(orgId)) {
      this.logger.log(`getBrainSuggestions 增强进行中，跳过本次触发 (org=${orgId})`);
      return;
    }
    this.brainEnhancingOrgs.add(orgId);
    try {
      await this.runWithTenantGuc(actor, async () => {
        await this.enrichBrainSuggestionsWithLlmInner(orgId, fallback);
      });
    } catch (error) {
      this.logger.warn(`getBrainSuggestions 异步增强失败：${String(error)}`);
    } finally {
      this.brainEnhancingOrgs.delete(orgId);
    }
  }

  /** 重建租户 GUC 上下文执行后台查询（无 RequestDatabaseContext 的测试环境直通）。 */
  private async runWithTenantGuc<T>(
    actor: OrgContext | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    if (!this.requestDatabaseContext || !actor) return op();
    return this.requestDatabaseContext.runInTransaction(
      buildGucSettings(actor),
      op,
    );
  }

  private async enrichBrainSuggestionsWithLlmInner(
    orgId: string,
    fallback: BrainSuggestion[],
  ): Promise<void> {
    const telemetryRows = await this.db
      .select({
        deviceId: ewohTelemetry.deviceId,
        avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
        avgBattery: sql<number>`coalesce(avg(${ewohTelemetry.batteryPct}), 100)::float`,
      })
      .from(ewohTelemetry)
      .where(
        and(
          eq(ewohTelemetry.orgId, orgId),
          gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
        ),
      )
      .groupBy(ewohTelemetry.deviceId);
    const openEvents = await this.db
      .select()
      .from(ewohEvent)
      .where(and(eq(ewohEvent.status, 'open'), eq(ewohEvent.orgId, orgId)));
    const lowBatteryDevices = await this.db
      .select({ deviceId: ewohDevice.deviceId, workerName: ewohDevice.workerName, batteryPct: ewohDevice.batteryPct })
      .from(ewohDevice)
      .where(and(sql`${ewohDevice.batteryPct} < 20`, eq(ewohDevice.orgId, orgId)));

    const enriched = await this.enrichBrainSuggestionsWithLlm(
      fallback,
      { telemetryRows, openEvents, lowBatteryDevices },
    );
    if (enriched && enriched.length > 0) {
      this.brainCacheByOrg.set(orgId, { suggestions: enriched, cachedAt: Date.now() });
      this.logger.log(`getBrainSuggestions cached ${enriched.length} LLM suggestions (org=${orgId})`);
    }
  }

  /** 基于真实数据 + Ark 大模型生成/优化大脑建议；失败时保留规则建议。 */
  private async enrichBrainSuggestionsWithLlm(
    fallback: BrainSuggestion[],
    data: {
      telemetryRows: Array<{ deviceId: string; avgLoad: number | null; avgBattery: number | null }>;
      openEvents: Array<{ eventId: string; severity: string | null; title: string | null; status: string | null }>;
      lowBatteryDevices: Array<{ deviceId: string; workerName: string | null; batteryPct: number | null }>;
    },
  ): Promise<BrainSuggestion[]> {
    if (!this.ark) return fallback;

    const lines: string[] = ['【近1小时设备负荷】'];
    for (const t of data.telemetryRows) {
      lines.push(`  ${t.deviceId}: 平均负荷=${t.avgLoad?.toFixed(2) ?? 'N/A'}, 平均电量=${t.avgBattery?.toFixed(1) ?? 'N/A'}%`);
    }
    lines.push('【未结事件】');
    for (const e of data.openEvents) {
      lines.push(`  ${e.eventId}: 严重度=${e.severity ?? 'N/A'}, ${e.title ?? ''}`);
    }
    lines.push('【低电量设备】');
    for (const d of data.lowBatteryDevices) {
      lines.push(`  ${d.deviceId} (${d.workerName ?? ''}): 电量=${d.batteryPct ?? 'N/A'}%`);
    }

    const systemPrompt =
      '你是工厂具身操作系统的智能大脑。基于给定的实时数据，从负荷均衡、换电、安全、节拍优化等角度给出' +
      '结构化、可执行的改善建议。' +
      '仅输出 JSON 数组，每项字段：type(: takt_improve|load_balance|battery_swap|safety_intervene|bottleneck_resolve), ' +
      'title(建议标题), description(建议描述), affectedEntities(受影响实体ID数组), expectedBenefit(预期收益), confidence(0-1 置信度)。' +
      '不要输出 markdown 代码块或其他文字。';
    const userPrompt = `实时数据：\n${lines.join('\n')}`;
    const result = await this.ark.ask(systemPrompt, userPrompt, { temperature: 0.4 });
    if (!result.ok) {
      this.logger.warn(`getBrainSuggestions LLM 不可用：${result.error}`);
      return fallback;
    }
    try {
      const parsed = JSON.parse(result.text) as Array<Partial<BrainSuggestion>>;
      if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
      const valid = parsed.filter(
        (s) =>
          typeof s.title === 'string' &&
          typeof s.description === 'string' &&
          ['takt_improve', 'load_balance', 'battery_swap', 'safety_intervene', 'bottleneck_resolve'].includes(
            s.type ?? '',
          ),
      );
      if (valid.length === 0) return fallback;
      return valid.map((s, i) => ({
        type: (s.type as BrainSuggestion['type']) ?? 'bottleneck_resolve',
        title: s.title ?? '',
        description: s.description ?? '',
        affectedEntities: Array.isArray(s.affectedEntities) ? s.affectedEntities.filter((v): v is string => typeof v === 'string') : [],
        expectedBenefit: s.expectedBenefit ?? '',
        confidence: typeof s.confidence === 'number' ? Math.min(1, Math.max(0, s.confidence)) : 0.5,
        suggestionId: `SUG-${s.type ?? 'brain'}-${i}`,
      }));
    } catch (e) {
      this.logger.warn(`getBrainSuggestions LLM 输出解析失败：${String(e)}`);
      return fallback;
    }
  }

  // ===== 私有辅助方法 =====

  /** 计算负荷均衡度（0-1，越高越均衡；基于标准差的归一化） */
  private computeStdDevNormalized(values: number[]): number {
    if (values.length === 0) return 1;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    // 归一化：stdDev 越小越均衡，1 / (1 + stdDev) 映射到 0-1
    return Number((1 / (1 + stdDev)).toFixed(3));
  }

  /** 从 metricsJson 提取关联实体 ID（兼容 resource_alloc / task_orchest 两种存储格式） */
  private extractEntityIds(metrics: Record<string, unknown>): string[] {
    const ids = new Set<string>();
    const allocated = metrics['allocatedEntities'];
    if (Array.isArray(allocated)) {
      for (const v of allocated) if (typeof v === 'string') ids.add(v);
    }
    const assigned = metrics['assignedEntities'];
    if (Array.isArray(assigned)) {
      for (const v of assigned) if (typeof v === 'string') ids.add(v);
    }
    return Array.from(ids);
  }

  private randomSuffix(len: number): string {
    // NEST-353：ID 后缀密码学化（Math.random 同秒碰撞可预测）。
    return randomUUID().replace(/-/g, '').slice(0, len);
  }
}
