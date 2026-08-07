import { Injectable, Inject, Optional, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ArkService } from '../ai/ark.service';
import {
  ewohDevice,
  ewohTelemetry,
  ewohEvent,
  ewohSpatialEntity,
  ewohSchedulePlan,
  ewohScheduleAudit,
} from '@server/database/schema';
import { eq, desc, and, sql, gte, inArray } from 'drizzle-orm';
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
  ) {}

  // ===== G3.1 玩家角色系统 =====

  getRole(): PlayerRoleInfo {
    const role = (process.env.EWOH_PLAYER_ROLE ?? 'shift_leader') as PlayerRole;
    const playerName = process.env.EWOH_PLAYER_NAME ?? '当前用户';

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

    const info = roleMap[role] ?? roleMap.shift_leader;
    return {
      role,
      roleName: info.roleName,
      visibleLevels: info.visibleLevels,
      permissions: info.permissions,
      playerName,
    };
  }

  // ===== G3.2 资源分配 =====

  async allocateResources(req: ResourceAllocationRequest): Promise<ResourceAllocationResult> {
    try {
      if (!req.allocations || req.allocations.length === 0) {
        throw new BadRequestException('allocations is required');
      }

      const operator = req.operator ?? 'supervisor';
      const planId = `ALLOC-${Date.now()}-${this.randomSuffix(4)}`;
      const allocationResults: ResourceAllocationResult['allocations'] = [];
      const conflicts: string[] = [];
      const suggestions: string[] = [];

      // 收集已分配人员/设备的 entity_id（用于负荷与电量评估）
      const allocatedEntityIds = req.allocations.map((a) => a.entityId);

      // 1. 冲突检测：人员离线（ewoh_device.device_id = entityId 且 online=false）
      const deviceRows = allocatedEntityIds.length
        ? await this.db
            .select()
            .from(ewohDevice)
            .where(inArray(ewohDevice.deviceId, allocatedEntityIds))
        : [];

      const offlineSet = new Set(deviceRows.filter((d) => d.online === false).map((d) => d.deviceId));
      const batteryByDevice = new Map<string, number>(
        deviceRows.map((d) => [d.deviceId, d.batteryPct ?? 100]),
      );

      // 2. 加载已分配人员最近 1h 的平均负荷（按 deviceId 聚合）
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
                gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
              ),
            )
            .groupBy(ewohTelemetry.deviceId)
        : [];
      const loadByDevice = new Map<string, number>(loadRows.map((r) => [r.deviceId, r.avgLoad ?? 0]));

      // 3. 逐条执行分配（更新 ewoh_spatial_entity.parent_id = targetId）
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
          await this.db
            .update(ewohSpatialEntity)
            .set({ parentId: alloc.targetId })
            .where(eq(ewohSpatialEntity.entityId, alloc.entityId));
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
      const skillMatch = 0.8; // 暂无技能数据，默认 0.8

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
      if (error instanceof BadRequestException) throw error;
      this.logger.error('allocateResources 失败', error);
      throw error;
    }
  }

  // ===== G3.3 任务编排 =====

  async orchestrateTask(req: TaskOrchestrationRequest): Promise<TaskOrchestrationResult> {
    try {
      if (!req.nodes || req.nodes.length === 0) {
        throw new BadRequestException('nodes is required');
      }

      const operator = req.operator ?? 'supervisor';
      const planId = `ORCH-${Date.now()}-${this.randomSuffix(4)}`;
      const now = new Date();

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
          .where(inArray(ewohSpatialEntity.entityId, workstationIds));
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
      if (error instanceof BadRequestException) throw error;
      this.logger.error('orchestrateTask 失败', error);
      throw error;
    }
  }

  // ===== G3.5 调度下发 =====

  async dispatchPlan(planId: string, req: DispatchRequest): Promise<DispatchResult> {
    try {
      // 1. 校验方案存在且已确认
      const [existing] = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(eq(ewohSchedulePlan.planId, planId))
        .limit(1);

      if (!existing) {
        throw new NotFoundException(`Schedule plan ${planId} not found`);
      }
      if (existing.status !== 'confirmed') {
        throw new BadRequestException(`Schedule plan ${planId} is not confirmed (current: ${existing.status})`);
      }

      const operator = req.operator ?? 'dispatcher';
      const now = new Date();

      // 2. 冲突检测：从 metricsJson 提取关联实体/设备，检查是否离线
      const metrics = (existing.metricsJson as Record<string, unknown> | null) ?? {};
      const entityIds = this.extractEntityIds(metrics);

      let conflicts: string[] = [];
      if (entityIds.length > 0) {
        const deviceRows = await this.db
          .select({ deviceId: ewohDevice.deviceId, online: ewohDevice.online, workerName: ewohDevice.workerName })
          .from(ewohDevice)
          .where(inArray(ewohDevice.deviceId, entityIds));
        conflicts = deviceRows
          .filter((d) => d.online === false)
          .map((d) => `设备 ${d.workerName ?? d.deviceId} 离线，无法下发`);
      }

      // 3. 写入审计 action='dispatch'
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

      // 4. 无冲突，更新方案状态为 'dispatched'
      await this.db
        .update(ewohSchedulePlan)
        .set({ status: 'dispatched' })
        .where(eq(ewohSchedulePlan.planId, planId));

      this.logger.log(`dispatchPlan planId=${planId} dispatched auditId=${auditRow.auditId}`);

      return {
        planId,
        status: 'dispatched',
        conflicts: [],
        dispatchedAt: now.toISOString(),
        auditId: auditRow.auditId,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      this.logger.error('dispatchPlan 失败', error);
      throw error;
    }
  }

  // ===== G3.6 外骨骼反馈 =====

  async sendExoFeedback(deviceId: string, req: ExoFeedbackRequest): Promise<ExoFeedbackResult> {
    try {
      // 1. 校验设备存在
      const [device] = await this.db
        .select()
        .from(ewohDevice)
        .where(eq(ewohDevice.deviceId, deviceId))
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

      // 3. 写入事件 ewoh_event
      const priority = req.priority ?? 'normal';
      const severityMap: Record<string, string> = {
        critical: 'L3',
        high: 'L2',
        normal: 'L1',
        low: 'L1',
      };
      const severity = severityMap[priority] ?? 'L1';
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
      this.logger.error('sendExoFeedback 失败', error);
      throw error;
    }
  }

  // ===== G3.7 大脑推理建议 =====

  /** LLM 增强结果的进程内缓存：先返回规则建议，LLM 异步增强后回写覆盖。 */
  private brainCache: BrainSuggestion[] | null = null;
  private brainCacheAt = 0;
  /** 标记当前是否有后台 LLM 增强正在执行（供前端展示「增强中」状态）。 */
  private brainEnhancing = false;

  /**
   * 大脑建议（G3.7）。
   * 设计：同步返回规则建议（毫秒级），LLM 增强在后台异步执行并写入缓存，
   * 后续轮询（前端每 10s）命中缓存后返回增强结果。
   * 返回前会为建议回填已存在的可审批方案 planId，打通「采纳 → 定位方案」闭环。
   */
  async getBrainSuggestions(): Promise<BrainSuggestion[]> {
    try {
      // 1. 先构造规则建议（毫秒级，不依赖 LLM）
      const suggestions = await this.buildRuleSuggestions();

      // 2. 若已有较新的 LLM 增强缓存，直接返回增强结果
      const cacheTtlMs = 10 * 60 * 1000;
      if (this.brainCache && Date.now() - this.brainCacheAt < cacheTtlMs) {
        this.logger.log(
          `getBrainSuggestions serving ${this.brainCache.length} cached (LLM) suggestions`,
        );
        return this.attachPlanIds(this.brainCache);
      }

      // 3. 返回规则建议，同时后台异步触发 LLM 增强并回写缓存
      void this.enrichBrainSuggestionsWithLlmAsync(suggestions);

      this.logger.log(`getBrainSuggestions returned ${suggestions.length} rule suggestions`);
      return this.attachPlanIds(
        suggestions.map((s) => ({ ...s, enhancing: this.brainEnhancing })),
      );
    } catch (error) {
      this.logger.error('getBrainSuggestions 失败', error);
      throw error;
    }
  }

  /**
   * 为建议回填已存在的可审批（proposed/confirmed）方案 planId。
   * 按建议类型映射到对应调度策略，取最近一条同策略方案关联。
   */
  private async attachPlanIds(suggestions: BrainSuggestion[]): Promise<BrainSuggestion[]> {
    if (suggestions.length === 0) return suggestions;
    try {
      const strategyByType = this.brainStrategyMap();
      const strategies = Array.from(
        new Set(suggestions.map((s) => strategyByType[s.type]).filter(Boolean)),
      );
      if (strategies.length === 0) return suggestions;

      const rows = await this.db
        .select({
          planId: ewohSchedulePlan.planId,
          strategy: ewohSchedulePlan.strategy,
          status: ewohSchedulePlan.status,
        })
        .from(ewohSchedulePlan)
        .where(
          and(
            inArray(ewohSchedulePlan.strategy, strategies),
            inArray(ewohSchedulePlan.status, ['proposed', 'confirmed']),
          ),
        )
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
  ): Promise<ApplyBrainSuggestionResult> {
    const operator = body.operator ?? 'supervisor';
    const now = new Date();
    const planId = `BRAIN-${Date.now()}-${this.randomSuffix(4)}`;
    const strategy = this.brainStrategyMap()[body.type] ?? 'load_balance';
    const planName = `大脑建议-${(body.title || body.type).slice(0, 20)}`;

    await this.db.insert(ewohSchedulePlan).values({
      planId,
      planName,
      strategy,
      status: 'proposed',
      taktImprovement: 0,
      highLoadPersons: body.type === 'load_balance' ? body.affectedEntities.length : 0,
      lowBatteryRisk: body.type === 'battery_swap' ? body.affectedEntities.length : 0,
      affectedPersons: body.affectedEntities.length,
      metricsJson: {
        affectedEntities: body.affectedEntities,
        confidence: body.confidence,
        expectedBenefit: body.expectedBenefit,
        source: 'brain',
        suggestionType: body.type,
      } as Record<string, unknown>,
      reason: body.description ?? body.title ?? '',
      createdAt: now,
    });

    await this.db.insert(ewohScheduleAudit).values({
      auditId: `AUDIT-${Date.now()}-${this.randomSuffix(4)}`,
      planId,
      action: 'brain_apply',
      operator,
      reason: `采纳大脑建议：${body.title}`,
      createdAt: now,
    });

    this.logger.log(`applyBrainSuggestion planId=${planId} strategy=${strategy} operator=${operator}`);
    return { planId, planName, strategy, status: 'proposed' };
  }

  /** 基于实时数据构造规则建议（不调用 LLM）。 */
  private async buildRuleSuggestions(): Promise<BrainSuggestion[]> {
    // 1. 查询最近 1h 遥测：按 deviceId 分组的平均负荷
    const telemetryRows = await this.db
      .select({
        deviceId: ewohTelemetry.deviceId,
        avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
        avgBattery: sql<number>`coalesce(avg(${ewohTelemetry.batteryPct}), 100)::float`,
      })
      .from(ewohTelemetry)
      .where(gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
      .groupBy(ewohTelemetry.deviceId);

    // 2. 查询未结事件
    const openEvents = await this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.status, 'open'));

    // 3. 查询低电量设备
    const lowBatteryDevices = await this.db
      .select({ deviceId: ewohDevice.deviceId, workerName: ewohDevice.workerName, batteryPct: ewohDevice.batteryPct })
      .from(ewohDevice)
      .where(sql`${ewohDevice.batteryPct} < 20`);

    const suggestions: BrainSuggestion[] = [];

    const highLoadDevices = telemetryRows.filter((r) => (r.avgLoad ?? 0) > 0.7);
    const overloadDevices = telemetryRows.filter((r) => (r.avgLoad ?? 0) > 0.8);
    const l3Events = openEvents.filter((e) => e.severity === 'L3');

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
    if (l3Events.length > 0) {
      suggestions.push({
        type: 'safety_intervene',
        title: 'L3 安全事件介入',
        description: `检测到 ${l3Events.length} 项 L3 级未结安全事件，建议立即介入处理。`,
        affectedEntities: l3Events.map((e) => e.eventId),
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

  /** 后台异步执行 LLM 增强，成功后回写缓存（失败不影响已返回的规则建议）。 */
  private async enrichBrainSuggestionsWithLlmAsync(
    fallback: BrainSuggestion[],
  ): Promise<void> {
    this.brainEnhancing = true;
    try {
      const telemetryRows = await this.db
        .select({
          deviceId: ewohTelemetry.deviceId,
          avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
          avgBattery: sql<number>`coalesce(avg(${ewohTelemetry.batteryPct}), 100)::float`,
        })
        .from(ewohTelemetry)
        .where(gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
        .groupBy(ewohTelemetry.deviceId);
      const openEvents = await this.db
        .select()
        .from(ewohEvent)
        .where(eq(ewohEvent.status, 'open'));
      const lowBatteryDevices = await this.db
        .select({ deviceId: ewohDevice.deviceId, workerName: ewohDevice.workerName, batteryPct: ewohDevice.batteryPct })
        .from(ewohDevice)
        .where(sql`${ewohDevice.batteryPct} < 20`);

      const enriched = await this.enrichBrainSuggestionsWithLlm(
        fallback,
        { telemetryRows, openEvents, lowBatteryDevices },
      );
      if (enriched && enriched.length > 0) {
        this.brainCache = enriched;
        this.brainCacheAt = Date.now();
        this.logger.log(`getBrainSuggestions cached ${enriched.length} LLM suggestions`);
      }
    } catch (error) {
      this.logger.warn(`getBrainSuggestions 异步增强失败：${String(error)}`);
    } finally {
      this.brainEnhancing = false;
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
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
}
