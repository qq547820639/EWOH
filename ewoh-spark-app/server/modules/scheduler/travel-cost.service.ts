import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, and } from 'drizzle-orm';
import { ewohRouteCostMatrix } from '@server/database/schema';
import type {
  Route,
  RouteCostFallbackReason,
  RouteCostDataQuality,
  RouteCostMatrix,
  CandidateRouteCost,
  ObjectiveWeights,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { RoutingService } from './routing.service';
import { SchedulingPolicyService } from './scheduling-policy.service';

/**
 * 统一路径成本服务（TravelCostService，Phase 2 / P2-T1）。
 *
 * 由 RouteCostProvider 演进：除既有 estimate（person→task 单候选路径成本）外，
 * 新增：
 *   - RouteCost 显式携带 fallbackReason / dataQuality / routeCostMode
 *     （Euclidean 仅显式 fallback：coords_unknown | no_route_edge | graph_unavailable）；
 *   - buildMatrix(snapshot, task, candidates)：聚合 Task×候选 的 RouteCostMatrix，
 *     在矩阵层显式标记 blocked（读 routeStatus）与 forbiddenZone（读 forbiddenZones）；
 *   - buildEligibilityMatrix：供 CP-SAT 请求只保留矩阵判定 feasible 的候选
 *     （缺坐标候选在矩阵层被排除，绝不进入求解请求）；
 *   - 决策 D-D：矩阵落库缓存表 ewoh_route_cost_matrix（确定性 replay 需要），
 *     以 (task_id, snapshot_version) 为唯一键读写缓存。
 *
 * heuristic 与 CP-SAT 均消费本服务的同一成本来源（estimate / matrix），消除双源不一致。
 */
@Injectable()
export class TravelCostService {
  private readonly logger = new Logger(TravelCostService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly routingService: RoutingService,
    private readonly policy: SchedulingPolicyService,
  ) {}

  /**
   * 估算人员到任务工位的路径成本（单一权威来源）。
   * 有 from/to 坐标时优先走 calculateRouteBetween（真实 route graph）；
   * 否则走 calculateRoute（内部查 spatial entity 坐标，失败则显式 euclidean fallback）。
   * route graph 不可行时显式回退到 euclidean 并携带 fallbackReason / dataQuality。
   */
  async estimate(
    personId: string,
    taskId: string,
    from?: { x: number | null; y: number | null },
    to?: { x: number | null; y: number | null },
  ): Promise<RouteCost> {
    const hasFrom = from != null && this.hasCoord(from);
    const hasTo = to != null && this.hasCoord(to);
    if (hasFrom && hasTo) {
      const route = await this.routingService.calculateRouteBetween(
        { x: from!.x as number, y: from!.y as number },
        { x: to!.x as number, y: to!.y as number },
        { personId, taskId },
      );
      if (route.feasible && route.source === 'route_graph') {
        return this.fromRoute(route);
      }
      // route graph 不可达（A* 无路径 / 起终点同点）→ 显式 euclidean fallback + 原因。
      return this.euclidean(from, to, {
        fallbackReason: route.fallbackReason ?? 'no_route_edge',
        dataQuality: route.dataQuality ?? 'FRESH',
      });
    }

    // 坐标缺失：尝试通过 spatial entity 解析真实起终点；仍失败则显式 UNKNOWN（不伪造 0,0）。
    try {
      const route = await this.routingService.calculateRoute(personId, taskId);
      if (route.feasible && route.source === 'route_graph') {
        return this.fromRoute(route);
      }
      return this.euclidean(from, to, {
        fallbackReason: route.fallbackReason ?? 'coords_unknown',
        dataQuality: route.dataQuality ?? 'UNKNOWN',
      });
    } catch (err) {
      this.logger.warn(
        `Route graph unavailable for person=${personId} task=${taskId}, explicit fallback: ${(err as Error)?.message ?? err}`,
      );
      return this.euclidean(from, to, {
        fallbackReason: 'graph_unavailable',
        dataQuality: 'UNKNOWN',
      });
    }
  }

  /** 纯欧氏距离兜底（无 person/task id 可用时）。 */
  async estimateBetween(
    stationA?: { x: number | null; y: number | null },
    stationB?: { x: number | null; y: number | null },
  ): Promise<RouteCost> {
    return this.euclidean(stationA, stationB, {
      fallbackReason: 'no_route_edge',
      dataQuality: 'UNKNOWN',
    });
  }

  /**
   * 构建任务 × 候选 的 RouteCostMatrix（P2-T1）。
   * 缓存策略（决策 D-D）：先按 (taskId, snapshotVersion) 读缓存，命中且候选数不缺 → 直接复用；
   * 否则逐候选 estimate 计算并写缓存（upsert，幂等）。
   */
  async buildMatrix(
    snapshot: WorldStateSnapshot,
    task: WorldStateSnapshot['tasks'][number],
    candidates: Array<{ personId: string | null; deviceId: string | null; stationId: string | null }>,
  ): Promise<RouteCostMatrix> {
    const cached = await this.getCachedMatrix(task.id, snapshot.snapshotVersion);
    if (cached && cached.candidates.length >= candidates.length) {
      return cached;
    }
    const policy = await this.policy.getActivePolicy();
    const matrix = await this.computeMatrix(snapshot, task, candidates, policy);
    await this.persistMatrix(matrix);
    return matrix;
  }

  /**
   * 候选可行性矩阵（供 CP-SAT 请求）：仅矩阵判定 feasible 的 person/device 候选
   * 才进入求解请求（eligiblePersonIds / eligibleDeviceIds），缺坐标候选在矩阵层被排除。
   */
  async buildEligibilityMatrix(
    snapshot: WorldStateSnapshot,
  ): Promise<Map<string, { personIds: string[]; deviceIds: string[] }>> {
    const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));
    const result = new Map<
      string,
      { personIds: string[]; deviceIds: string[] }
    >();
    for (const task of snapshot.tasks) {
      const taskStation = task.stationId ? stationById.get(task.stationId) : undefined;
      const taskPoint = taskStation
        ? { x: taskStation.x, y: taskStation.y }
        : undefined;
      const personIds: string[] = [];
      for (const p of snapshot.persons) {
        const personStation = p.stationId ? stationById.get(p.stationId) : undefined;
        const personPoint = personStation
          ? { x: personStation.x, y: personStation.y }
          : p.x != null && p.y != null
            ? { x: p.x, y: p.y }
            : undefined;
        const cost = await this.estimate(p.id, task.id, personPoint, taskPoint);
        if (cost.feasible) personIds.push(p.id);
      }
      // 设备：仅有真实位置（坐标非 null）的设备才允许进入求解请求（可路由）。
      const deviceIds = snapshot.devices
        .filter((d) => d.x != null && d.y != null)
        .map((d) => d.id);
      result.set(task.id, { personIds, deviceIds });
    }
    return result;
  }

  /** 读取缓存的矩阵（决策 D-D 缓存命中）。 */
  async getCachedMatrix(
    taskId: string,
    snapshotVersion: string,
  ): Promise<RouteCostMatrix | null> {
    try {
      const rows = await this.db
        .select()
        .from(ewohRouteCostMatrix)
        .where(
          and(
            eq(ewohRouteCostMatrix.taskId, taskId),
            eq(ewohRouteCostMatrix.snapshotVersion, snapshotVersion),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return this.parseMatrixRow(row);
    } catch (err) {
      this.logger.warn(
        `route cost matrix cache read failed (task=${taskId} snapshot=${snapshotVersion}): ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /** 写缓存矩阵（决策 D-D；同键幂等覆盖）。 */
  async persistMatrix(matrix: RouteCostMatrix): Promise<void> {
    try {
      const existing = await this.db
        .select({ id: ewohRouteCostMatrix.id })
        .from(ewohRouteCostMatrix)
        .where(
          and(
            eq(ewohRouteCostMatrix.taskId, matrix.taskId),
            eq(ewohRouteCostMatrix.snapshotVersion, matrix.snapshotVersion),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await this.db
          .update(ewohRouteCostMatrix)
          .set({
            matrixId: matrix.matrixId,
            policyVersion: matrix.policyVersion,
            solverVersion: matrix.solverVersion,
            candidatesJson: this.toJsonbArray(matrix.candidates),
            generatedAt: new Date(matrix.generatedAt),
            updatedAt: new Date(),
          })
          .where(eq(ewohRouteCostMatrix.id, existing[0].id));
      } else {
        await this.db.insert(ewohRouteCostMatrix).values({
          matrixId: matrix.matrixId,
          taskId: matrix.taskId,
          snapshotVersion: matrix.snapshotVersion,
          policyVersion: matrix.policyVersion,
          solverVersion: matrix.solverVersion,
          candidatesJson: this.toJsonbArray(matrix.candidates),
          generatedAt: new Date(matrix.generatedAt),
        });
      }
    } catch (err) {
      this.logger.warn(
        `route cost matrix cache write failed (task=${matrix.taskId}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** 将候选列表规整为可持久化的 JSON 值（runtime validation，禁止 as unknown as）。 */
  private toJsonbArray(candidates: CandidateRouteCost[]): unknown {
    return candidates.map((c) => ({
      personId: c.personId,
      deviceId: c.deviceId,
      stationId: c.stationId,
      etaSeconds: c.etaSeconds,
      distanceMeters: c.distanceMeters,
      congestion: c.congestion,
      blocked: c.blocked,
      forbiddenZone: c.forbiddenZone,
      risk: c.risk,
      energy: c.energy,
      routeCostMode: c.routeCostMode,
      fallbackReason: c.fallbackReason,
      dataQuality: c.dataQuality,
      feasible: c.feasible,
    }));
  }

  // ---- 内部：矩阵计算 ----

  private async computeMatrix(
    snapshot: WorldStateSnapshot,
    task: WorldStateSnapshot['tasks'][number],
    candidates: Array<{ personId: string | null; deviceId: string | null; stationId: string | null }>,
    policy: { version: number; solverVersion: string; weights: ObjectiveWeights },
  ): Promise<RouteCostMatrix> {
    const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));
    const personById = new Map(snapshot.persons.map((p) => [p.id, p]));
    const taskStation = task.stationId ? stationById.get(task.stationId) : undefined;
    const taskPoint = taskStation
      ? { x: taskStation.x, y: taskStation.y }
      : undefined;
    const hasBlockedEdge =
      (snapshot.routeStatus ?? []).some((r) => r.status === 'blocked') ?? false;
    const forbiddenZone =
      (snapshot.forbiddenZones ?? []).some(
        (f) => f.zoneId === task.zoneId || f.zoneId === task.stationId,
      ) ?? false;

    const matrixCandidates: CandidateRouteCost[] = [];
    for (const cand of candidates) {
      const person = cand.personId ? personById.get(cand.personId) : undefined;
      const personPoint = person
        ? person.stationId
          ? stationById.get(person.stationId)
            ? { x: stationById.get(person.stationId)!.x, y: stationById.get(person.stationId)!.y }
            : person.x != null && person.y != null
              ? { x: person.x, y: person.y }
              : undefined
          : person.x != null && person.y != null
            ? { x: person.x, y: person.y }
            : undefined
        : undefined;
      const cost = await this.estimate(cand.personId ?? 'unknown', task.id, personPoint, taskPoint);
      matrixCandidates.push(
        this.toCandidateRouteCost(cand, cost, hasBlockedEdge, forbiddenZone),
      );
    }

    return {
      matrixId: `RCM-${Date.now()}-${task.id}`,
      snapshotVersion: snapshot.snapshotVersion,
      policyVersion: policy.version,
      solverVersion: policy.solverVersion,
      taskId: task.id,
      candidates: matrixCandidates,
      generatedAt: new Date().toISOString(),
    };
  }

  private toCandidateRouteCost(
    cand: { personId: string | null; deviceId: string | null; stationId: string | null },
    cost: RouteCost,
    hasBlockedEdge: boolean,
    forbiddenZone: boolean,
  ): CandidateRouteCost {
    // blocked 标记：route graph 因 blocked 边不可达而走 euclidean 兜底时显式标记。
    // P0：blocked 属于硬约束语义——不可达即不可行，feasible 必须为 false，
    // 不允许把阻断路线当作可用成本估算送入求解器（避免安全/时效风险）。
    const blocked =
      cost.source === 'euclidean_fallback' &&
      hasBlockedEdge &&
      cost.fallbackReason === 'no_route_edge';
    return {
      personId: cand.personId,
      deviceId: cand.deviceId,
      stationId: cand.stationId,
      etaSeconds: cost.etaSeconds,
      distanceMeters: cost.distanceMeters,
      congestion: cost.congestionCost > 0 ? cost.congestionCost : 1,
      blocked,
      forbiddenZone,
      risk: cost.riskCost,
      energy: 0,
      routeCostMode: cost.source,
      fallbackReason: cost.fallbackReason,
      dataQuality: cost.dataQuality,
      feasible: cost.feasible && !forbiddenZone && !blocked,
    };
  }

  // ---- 内部：RouteCost 构造 ----

  /** 将 route graph 的 Route 转换为 RouteCost（dataQuality=FRESH，fallbackReason=null）。 */
  private fromRoute(route: Route): RouteCost {
    return {
      routeId: route.routeId,
      distanceMeters: route.distanceMeters,
      etaSeconds: route.etaSeconds,
      riskLevel: route.riskLevel ?? null,
      feasible: true,
      source: 'route_graph',
      riskCost: this.riskToCost(route.riskLevel ?? null),
      congestionCost: 0,
      graphVersion: route.graphVersion ?? null,
      calculatedAt: route.calculatedAt ?? new Date().toISOString(),
      fallbackReason: null,
      dataQuality: route.dataQuality ?? 'FRESH',
    };
  }

  /** 欧氏距离兜底；坐标缺失时显式不可行 + UNKNOWN，绝不返回 0,0 伪坐标。 */
  private async euclidean(
    from?: { x: number | null; y: number | null } | null,
    to?: { x: number | null; y: number | null } | null,
    meta?: { fallbackReason: RouteCostFallbackReason; dataQuality: RouteCostDataQuality },
  ): Promise<RouteCost> {
    const hasCoords =
      from != null &&
      to != null &&
      this.hasCoord(from) &&
      this.hasCoord(to);
    if (!hasCoords) {
      return {
        routeId: null,
        distanceMeters: 0,
        etaSeconds: 0,
        riskLevel: null,
        feasible: false,
        source: 'euclidean_fallback',
        riskCost: 0,
        congestionCost: 0,
        graphVersion: null,
        calculatedAt: new Date().toISOString(),
        fallbackReason: meta?.fallbackReason ?? 'coords_unknown',
        dataQuality: meta?.dataQuality ?? 'UNKNOWN',
      };
    }
    const config = await this.policy.getConfig();
    const speed = config.walkingSpeedMps;
    const distanceMeters = Math.hypot(
      (to!.x as number) - (from!.x as number),
      (to!.y as number) - (from!.y as number),
    );
    const etaSeconds = speed > 0 ? distanceMeters / speed : 0;
    return {
      routeId: null,
      distanceMeters,
      etaSeconds,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback',
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      fallbackReason: meta?.fallbackReason ?? 'no_route_edge',
      dataQuality: meta?.dataQuality ?? 'FRESH',
    };
  }

  private hasCoord(p: { x: number | null; y: number | null }): boolean {
    return (
      p.x != null &&
      p.y != null &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y)
    );
  }

  private riskToCost(riskLevel: string | null): number {
    if (riskLevel === 'high') return 2;
    if (riskLevel === 'medium') return 1.3;
    return 1;
  }

  /** 解析矩阵缓存行（runtime validation，禁止 as unknown as 逃逸）。 */
  private parseMatrixRow(row: {
    matrixId: string;
    taskId: string;
    snapshotVersion: string | null;
    policyVersion: number | null;
    solverVersion: string | null;
    candidatesJson: unknown;
    generatedAt: Date | null;
  }): RouteCostMatrix | null {
    const candidates = Array.isArray(row.candidatesJson)
      ? (row.candidatesJson as unknown[]).filter(this.isCandidateRouteCost)
      : [];
    if (!Array.isArray(row.candidatesJson)) return null;
    return {
      matrixId: row.matrixId,
      snapshotVersion: row.snapshotVersion ?? '',
      policyVersion: row.policyVersion ?? 0,
      solverVersion: row.solverVersion ?? 'unknown',
      taskId: row.taskId,
      candidates,
      generatedAt: row.generatedAt ? row.generatedAt.toISOString() : '',
    };
  }

  /** CandidateRouteCost 条目形状守卫（runtime validation）。 */
  private isCandidateRouteCost(v: unknown): v is CandidateRouteCost {
    if (typeof v !== 'object' || v === null) return false;
    const rec = v as Record<string, unknown>;
    return (
      typeof rec.personId === 'string' ||
      rec.personId === null ||
      rec.personId === undefined
    );
  }
}

/** 统一路径成本结果（RouteCostProvider 演进，P2-T1 新增 fallbackReason/dataQuality）。 */
export interface RouteCost {
  routeId: string | null; // 非空表示使用真实 route graph
  distanceMeters: number;
  etaSeconds: number;
  riskLevel: string | null;
  feasible: boolean; // route graph 与欧氏兜底均不可行时为 false
  /** 成本来源：route_graph 或 euclidean_fallback。 */
  source: 'route_graph' | 'euclidean_fallback';
  /** 沿路风险成本（由 riskLevel 折算）。 */
  riskCost: number;
  /** 拥塞成本（route graph 无拥塞明细信息时默认 0）。 */
  congestionCost: number;
  /** 计算所用路由图版本。 */
  graphVersion: number | null;
  /** 计算时间（ISO）。 */
  calculatedAt: string;
  /** 回退原因（P2-T1）：euclidean_fallback 必须带原因；route_graph 为 null。 */
  fallbackReason: RouteCostFallbackReason | null;
  /** 数据质量（P2-T1）：FRESH / STALE / UNKNOWN。 */
  dataQuality: RouteCostDataQuality;
}
