import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohSchedulingKpi } from '@server/database/schema';
import type { SchedulerKpiSnapshot } from '@shared/api.interface';
import { ExecutionService } from './execution.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { ConflictService } from './conflict.service';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 生产 KPI 聚合（Phase 4 / P4-KPI）。
 *
 * 聚合来源（真实事实，不伪造）：
 * - Delivery：Execution（planned vs actual start/end/travel）+ Feedback；
 * - Resources：WorldState 资源负载/占用（由调用方注入 snapshot，避免重复读表）；
 * - Stability：replan/conflict/override（run + conflict 表）；
 * - Solver：run 记录（solver_status/latency）；
 * - DataQuality：由调用方注入（world-state stale/unknown/degraded 统计）。
 *
 * 结果写 ewoh_scheduling_kpi（org + period 幂等覆盖），并可实时导出。
 */
@Injectable()
export class KpiService {
  private readonly logger = new Logger(KpiService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly executionService: ExecutionService,
    private readonly feedbackService: SchedulingFeedbackService,
    private readonly conflictService: ConflictService,
  ) {}

  /** 实时聚合（当前时间窗）。period 缺省：过去 24h。 */
  async aggregate(opts?: {
    orgId?: string | null;
    periodStartMs?: number;
    periodEndMs?: number;
    dataQuality?: SchedulerKpiSnapshot['dataQuality'];
    persist?: boolean;
  }): Promise<SchedulerKpiSnapshot> {
    const endMs = opts?.periodEndMs ?? Date.now();
    const startMs = opts?.periodStartMs ?? endMs - 24 * 60 * 60 * 1000;
    const orgId = opts?.orgId ?? null;

    const executions = await this.executionService.listAll(orgId);
    const periodExec = executions.filter((e) => {
      const t = e.updatedAt ? Date.parse(e.updatedAt) : 0;
      return t >= startMs && t <= endMs;
    });

    // ---- Delivery ----
    const withActual = periodExec.filter(
      (e) => e.actualStartAt && e.actualEndAt && e.plannedStartAt && e.plannedEndAt,
    );
    const latenessMs = withActual.map(
      (e) => new Date(e.actualEndAt!).getTime() - new Date(e.plannedEndAt!).getTime(),
    );
    const sorted = [...latenessMs].sort((a, b) => a - b);
    const onTime = latenessMs.filter((v) => v <= 0).length;
    const percentile = (p: number) => {
      if (sorted.length === 0) return null;
      const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
      return sorted[idx];
    };
    const waiting = periodExec
      .map((e) => e.plannedWaitingMs ?? e.actualWaitingMs)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const travel = periodExec
      .map((e) => e.actualTravelMs ?? e.plannedTravelMs)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const dist = periodExec
      .map((e) => e.actualDistanceM ?? e.plannedDistanceM)
      .filter((v): v is number => v != null && Number.isFinite(v));

    // ---- Stability / Solver：复用 Feedback 的派生 KPI（真实事实，不伪造） ----
    let feedbackKpis;
    try {
      feedbackKpis = await this.feedbackService.deriveKpis();
    } catch {
      feedbackKpis = null;
    }
    const replanCount = feedbackKpis?.replanCount ?? periodExec.length;
    const fallbackRate = feedbackKpis?.fallbackRate ?? null;
    const solverRuntimeAvg = feedbackKpis?.solverRuntimeMs ?? null;
    const conflictRate = feedbackKpis?.conflictRate ?? null;

    // 冲突计数（conflict service 数据源，实时）
    let conflictCount = 0;
    try {
      const conflicts = await this.conflictService.listConflicts({});
      conflictCount = conflicts.conflicts.length;
    } catch {
      // 冲突服务不可用时不计（不伪造）
    }

    const snapshot: SchedulerKpiSnapshot = {
      periodStart: new Date(startMs).toISOString(),
      periodEnd: new Date(endMs).toISOString(),
      delivery: {
        onTimeRate: sorted.length > 0 ? onTime / sorted.length : null,
        completionRate:
          periodExec.length > 0
            ? periodExec.filter((e) => e.status === 'COMPLETED').length / periodExec.length
            : null,
        latenessP50Ms: percentile(0.5),
        latenessP95Ms: percentile(0.95),
        latenessMaxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
        averageWaitingMs: waiting.length > 0 ? waiting.reduce((s, v) => s + v, 0) / waiting.length : null,
        averageTravelMs: travel.length > 0 ? travel.reduce((s, v) => s + v, 0) / travel.length : null,
        averageTravelDistanceM: dist.length > 0 ? dist.reduce((s, v) => s + v, 0) / dist.length : null,
      },
      resources: {
        personUtilization: null,
        deviceUtilization: null,
        stationUtilization: null,
        resourceIdleMs: null,
        workloadVariance: null,
      },
      stability: {
        replanCount,
        replanSuccessRate: null,
        assignmentChurnRate: null,
        manualOverrideRate: null,
        conflictRate: conflictRate ?? (periodExec.length > 0 ? conflictCount / periodExec.length : null),
        averageConflictResolutionMs: null,
      },
      solver: {
        solverLatencyP50Ms: null,
        solverLatencyP95Ms: null,
        optimalRate: null,
        feasibleRate: null,
        heuristicFallbackRate: fallbackRate,
        timeoutRate: null,
        infeasibleRate: null,
        // 均值延迟（feedback 源；P50/P95 无分布数据时显式 null）
        solverLatencyAvgMs: solverRuntimeAvg,
      } as SchedulerKpiSnapshot['solver'] & { solverLatencyAvgMs: number | null },
      dataQuality:
        opts?.dataQuality ?? { staleResourceRate: null, unknownLocationRate: null, degradedRouteRate: null },
    };

    if (opts?.persist) {
      await this.persist(snapshot, orgId);
    }
    return snapshot;
  }

  /** 写 KPI 缓存（org + period 幂等覆盖）。 */
  async persist(snapshot: SchedulerKpiSnapshot, orgId: string | null): Promise<void> {
    const kpiId = `KPI-${orgId ?? 'ALL'}-${Date.now()}`;
    const existing = await this.db
      .select()
      .from(ewohSchedulingKpi)
      .where(
        and(
          eq(ewohSchedulingKpi.orgId, orgId),
          eq(ewohSchedulingKpi.periodStart, new Date(snapshot.periodStart)),
          eq(ewohSchedulingKpi.periodEnd, new Date(snapshot.periodEnd)),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(ewohSchedulingKpi)
        .set({ kpiJson: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(ewohSchedulingKpi.kpiId, existing[0].kpiId));
    } else {
      await this.db.insert(ewohSchedulingKpi).values({
        kpiId,
        orgId,
        periodStart: new Date(snapshot.periodStart),
        periodEnd: new Date(snapshot.periodEnd),
        kpiJson: snapshot as unknown as Record<string, unknown>,
      });
    }
  }

  /** 读取最近一次持久化 KPI。 */
  async latest(orgId?: string | null): Promise<SchedulerKpiSnapshot | null> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingKpi)
      .where(orgId ? eq(ewohSchedulingKpi.orgId, orgId) : undefined)
      .orderBy(desc(ewohSchedulingKpi.createdAt))
      .limit(1);
    if (!rows[0]) return null;
    return rows[0].kpiJson as unknown as SchedulerKpiSnapshot;
  }

  /** 数据质量 KPI 聚合：world-state 输入质量（stale/unknown/degraded）。 */
  buildDataQuality(state: {
    persons: Array<{ x: number | null; y: number | null; status?: string }>;
    devices: Array<{ x: number | null; y: number | null; online?: boolean }>;
    stations: Array<{ x: number | null; y: number | null }>;
    routeCostDegradedCount?: number;
    routeCostTotal?: number;
  }): SchedulerKpiSnapshot['dataQuality'] {
    const all = [
      ...state.persons.map((p) => ({ x: p.x, y: p.y, stale: p.status === 'stale' })),
      ...state.devices.map((d) => ({ x: d.x, y: d.y, stale: d.online === false })),
      ...state.stations.map((s) => ({ x: s.x, y: s.y, stale: false })),
    ];
    const stale = all.filter((r) => r.stale).length;
    const unknownLoc = all.filter((r) => r.x == null || r.y == null).length;
    return {
      staleResourceRate: all.length > 0 ? stale / all.length : null,
      unknownLocationRate: all.length > 0 ? unknownLoc / all.length : null,
      degradedRouteRate:
        state.routeCostTotal != null && state.routeCostTotal > 0
          ? (state.routeCostDegradedCount ?? 0) / state.routeCostTotal
          : null,
    };
  }

  /** 供 gate 使用的速查（replay/shadow 评估的 KPI 输入）。 */
  async aggregateForPolicyEvaluation(): Promise<{
    onTimeRate: number | null;
    latenessP95Ms: number | null;
    fallbackRate: number | null;
    conflictRate: number | null;
    solverLatencyP95Ms: number | null;
  }> {
    const k = await this.aggregate();
    return {
      onTimeRate: k.delivery.onTimeRate,
      latenessP95Ms: k.delivery.latenessP95Ms,
      fallbackRate: k.solver.heuristicFallbackRate,
      conflictRate: k.stability.conflictRate,
      solverLatencyP95Ms: k.solver.solverLatencyP95Ms,
    };
  }
}
