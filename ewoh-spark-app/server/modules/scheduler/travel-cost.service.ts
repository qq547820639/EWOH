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
   * 缓存策略（决策 D-D，Task 4 扩展 key 版本化）：判读 key =
   *   snapshotVersion + policyVersion + routeGraphVersion + taskId + candidateSetHash，
   * 命中且候选数不缺 → 直接复用；否则逐候选 estimate 计算并写缓存（upsert，幂等）。
   * 避免不同策略版本/不同候选集合错误复用矩阵。
   */
  async buildMatrix(
    snapshot: WorldStateSnapshot,
    task: WorldStateSnapshot['tasks'][number],
    candidates: Array<{ personId: string | null; deviceId: string | null; stationId: string | null }>,
  ): Promise<RouteCostMatrix> {
    const policy = await this.policy.getActivePolicy();
    const routeGraphVersion = this.routeGraphVersionOf(snapshot);
    const candHash = candidateSetHash(candidates);
    const cached = await this.getCachedMatrix(
      task.id,
      snapshot.snapshotVersion,
      policy.version,
      routeGraphVersion,
      candHash,
    );
    if (cached && cached.candidates.length >= candidates.length) {
      return cached;
    }
    const matrix = await this.computeMatrix(
      snapshot,
      task,
      candidates,
      policy,
      routeGraphVersion,
      candHash,
    );
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

  /**
   * 读取缓存的矩阵（决策 D-D 缓存命中）。
   * Task 4：判读 key 扩展为
   *   snapshotVersion + policyVersion + routeGraphVersion + taskId + candidateSetHash。
   * 由于 ewoh_route_cost_matrix 表无 routeGraphVersion/candidateSetHash 列（Option B，
   * 避免 schema/migration），此处仅按 (taskId, snapshotVersion) 取行，再在内存中校验
   * policyVersion / routeGraphVersion / candidateSetHash 三者一致才命中。
   */
  async getCachedMatrix(
    taskId: string,
    snapshotVersion: string,
    policyVersion: number,
    routeGraphVersion: string,
    candidateSetHashKey: string,
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
      // Option B：内存校验完整缓存 key，避免不同策略/候选集错误复用矩阵。
      if (row.policyVersion !== policyVersion) return null;
      const parsed = this.parseMatrixRow(row);
      if (!parsed) return null;
      if (parsed.routeGraphVersion !== routeGraphVersion) return null;
      if (parsed.candidateSetHash !== candidateSetHashKey) return null;
      return parsed;
    } catch (err) {
      this.logger.warn(
        `route cost matrix cache read failed (task=${taskId} snapshot=${snapshotVersion} policy=${policyVersion} hash=${candidateSetHashKey}): ${(err as Error)?.message ?? err}`,
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
    routeGraphVersion: string,
    candidateSetHashKey: string,
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
      matrixId: `RCM-${routeGraphVersion}-${candidateSetHashKey}-${Date.now()}-${task.id}`,
      snapshotVersion: snapshot.snapshotVersion,
      policyVersion: policy.version,
      solverVersion: policy.solverVersion,
      routeGraphVersion,
      candidateSetHash: candidateSetHashKey,
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
      // P4-GEOM：routeCostId（deterministic）+ 路径几何（与 Solver/地图同源 RouteCost）。
      routeCostId: `RC-${cand.personId ?? 'any'}-${cand.deviceId ?? 'any'}-${cand.stationId ?? 'any'}`,
      geometry: cost.geometry ?? [],
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
      // P0：真实 A* 路径几何透传（Route.geometry），供地图与批量候选端点使用。
      geometry: Array.isArray(route.geometry) ? route.geometry : [],
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
    // §5.4 三级策略：STRICT 下 euclidean 降级候选显式不可行（route_infeasible 下游拒绝）；
    // DEGRADED/ADVISORY/未配置（缺省）保持现状：feasible=true + fallbackReason/dataQuality/惩罚。
    const strictMode = config.routeCostMode === 'STRICT';
    return {
      routeId: null,
      distanceMeters,
      etaSeconds,
      riskLevel: null,
      feasible: !strictMode,
      source: 'euclidean_fallback',
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      fallbackReason: meta?.fallbackReason ?? 'no_route_edge',
      dataQuality: meta?.dataQuality ?? 'FRESH',
      // P0：显式 degraded fallback 的直线几何（起→终点两点），与 feasible=true 语义一致。
      geometry: [
        { x: from!.x as number, y: from!.y as number },
        { x: to!.x as number, y: to!.y as number },
      ],
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

  /**
   * 路由图版本（Task 4 缓存 key 维度）。WorldStateSnapshot 无显式 route graph 版本，
   * 以全局单调递增的 worldVersion 作为 route graph 版本代理；缺失时回退 'default'。
   */
  private routeGraphVersionOf(snapshot: WorldStateSnapshot): string {
    return snapshot.worldVersion != null ? String(snapshot.worldVersion) : 'default';
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
    // Task 4（Option B）：routeGraphVersion/candidateSetHash 无独立列，编码在 matrixId
    // 的 `RCM-<rv>-<hash>-<ts>-<taskId>` 前缀中，读取时解出用于缓存 key 校验。
    const parts = row.matrixId.split('-');
    const routeGraphVersion = parts[1] ?? null;
    const candidateSetHashKey = parts[2] ?? null;
    return {
      matrixId: row.matrixId,
      snapshotVersion: row.snapshotVersion ?? '',
      policyVersion: row.policyVersion ?? 0,
      solverVersion: row.solverVersion ?? 'unknown',
      routeGraphVersion,
      candidateSetHash: candidateSetHashKey,
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
  /**
   * 路径几何（P0）：route_graph 为真实 A* 折线路径；euclidean 为起终点两点。
   * 地图渲染与 Solver 使用同一几何，禁止前端自行连直线。
   */
  geometry?: Array<{ x: number; y: number }>;
}

/**
 * 候选集合哈希（Task 4.2）：从候选 id 生成确定性哈希，用于区分不同候选集的矩阵缓存。
 * 对每个候选产出 `personId|deviceId|stationId`，字典序排序后以 `::` 拼接，再 FNV-1a 稳定哈希。
 * 相同输入永远得到相同输出；候选顺序无关。
 */
export function candidateSetHash(
  candidates: Array<{ personId: string | null; deviceId: string | null; stationId: string | null }>,
): string {
  const input = candidates
    .map((c) => `${c.personId ?? ''}|${c.deviceId ?? ''}|${c.stationId ?? ''}`)
    .sort()
    .join('::');
  // FNV-1a 32-bit（确定性、稳定、无外部依赖）。
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
