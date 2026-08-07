import { Injectable } from '@nestjs/common';

/**
 * 调度可观测指标（Phase 3.2）。
 *
 * 以纯内存计数器/直方图/仪表的形式暴露调度系统的关键可观测指标，
 * 并提供 Prometheus text 格式渲染器（renderMetrics），供
 * GET /api/scheduler/metrics 端点输出。
 *
 * 设计约束：不修改任何受保护文件（plan.service / solver.service 等），
 * 本服务仅提供指标的记录方法；调用方在需要埋点处调用对应 record* 方法即可。
 * 日志与调用方负责携带 runId/planId/snapshotVersion/policyVersion/solverVersion。
 */
@Injectable()
export class SchedulerMetricsService {
  /** 计数器：metricName{label="value",...} -> count。 */
  private readonly counters = new Map<string, number>();
  /** 直方图桶（ms）：scheduler_run_duration_ms 使用固定桶。 */
  private readonly durationBucketsMs = [50, 100, 250, 500, 1000, 2000, 5000, 10000];
  /** 直方图累计 sum（ms）。 */
  private histogramSum = 0;
  private readonly histogramName = 'scheduler_run_duration_ms';
  /** gauge：名称 -> 值。 */
  private readonly gauges = new Map<string, number>();

  private inc(key: string, by = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /**
   * 记录一次调度运行。
   * @param durationMs 本次调度总耗时（ms）
   * @param feasible 是否可分配全部任务
   */
  recordRun(opts: {
    durationMs: number;
    feasible: boolean;
    solverVersion?: string;
    solverStatus?: string;
  }): void {
    const solverVersion = opts.solverVersion ?? 'unknown';
    const solverStatus = opts.solverStatus ?? 'unknown';
    const feasible = opts.feasible ? 'true' : 'false';
    this.inc(`scheduler_run_total{solver_version="${solverVersion}",status="${solverStatus}"}`);
    this.inc(`scheduler_run_total{solver_version="${solverVersion}",status="${solverStatus}",feasible="${feasible}"}`);

    // 累计直方图
    const d = opts.durationMs;
    this.histogramSum += d;
    this.inc(`${this.histogramName}_sum_bucket`);
    for (const b of this.durationBucketsMs) {
      if (d <= b) {
        this.inc(`${this.histogramName}_bucket{le="${b}"}`);
      }
    }
    this.inc(`${this.histogramName}_bucket{le="+Inf"}`);

    // feasible_ratio gauge（最近一次运行）
    this.gauges.set('scheduler_feasible_ratio', opts.feasible ? 1 : 0);
  }

  /** 记录一次求解超时。 */
  recordSolverTimeout(): void {
    this.inc('scheduler_solver_timeout_total');
  }

  /** 记录一次 CP-SAT → heuristic 回退。 */
  recordFallback(): void {
    this.inc('scheduler_fallback_total');
  }

  /** 记录一次方案确认。 */
  recordPlanApproved(planId?: string): void {
    this.inc(planId ? `plan_approved_total{plan_id="${planId}"}` : 'plan_approved_total');
  }

  /** 记录一次方案驳回。 */
  recordPlanRejected(planId?: string): void {
    this.inc(planId ? `plan_rejected_total{plan_id="${planId}"}` : 'plan_rejected_total');
  }

  /** 记录一次方案判定为 stale。 */
  recordPlanStale(planId?: string): void {
    this.inc(planId ? `plan_stale_total{plan_id="${planId}"}` : 'plan_stale_total');
  }

  /** 记录一次重排（replan）。 */
  recordReplan(): void {
    this.inc('replan_total');
  }

  /** 记录一次资源预约冲突。 */
  recordReservationConflict(): void {
    this.inc('reservation_conflict_total');
  }

  /** 记录一次人工覆盖（manual override）。 */
  recordManualOverride(): void {
    this.inc('manual_override_total');
  }

  /** 测试用：清空全部指标。 */
  reset(): void {
    this.counters.clear();
    this.histogramSum = 0;
    this.gauges.clear();
  }

  /** 快照当前计数（供测试断言）。 */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    for (const [k, v] of this.gauges) out[k] = v;
    if (this.histogramSum !== 0) out[`${this.histogramName}_sum`] = this.histogramSum;
    return out;
  }

  /**
   * 渲染 Prometheus text 格式。线程安全（仅拼接当前快照）。
   */
  renderMetrics(): string {
    const lines: string[] = [];

    // 计数器
    const counterDefinitions: Array<[string, string]> = [
      ['scheduler_run_total', '调度运行总次数（按求解器版本/状态/可行性）'],
      ['scheduler_solver_timeout_total', '求解超时总次数'],
      ['scheduler_fallback_total', 'CP-SAT 回退启发式总次数'],
      ['plan_approved_total', '方案确认总次数'],
      ['plan_rejected_total', '方案驳回总次数'],
      ['plan_stale_total', '方案判定 stale 总次数'],
      ['replan_total', '重排总次数'],
      ['reservation_conflict_total', '资源预约冲突总次数'],
      ['manual_override_total', '人工覆盖总次数'],
    ];
    for (const [name, help] of counterDefinitions) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      // 按 base name 聚合各 label 变体
      const variants = [...this.counters.entries()].filter(([k]) => k.startsWith(name));
      if (variants.length === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [key, val] of variants) {
          // key 形如 name{...} 或 name
          const [base, rest] = key.includes('{') ? [key.slice(0, key.indexOf('{')), key.slice(key.indexOf('{'))] : [key, ''];
          void base;
          lines.push(`${name}${rest} ${val}`);
        }
      }
    }

    // gauge
    lines.push('# HELP scheduler_feasible_ratio 最近一次调度运行的可分配率（1=全部可分配）');
    lines.push('# TYPE scheduler_feasible_ratio gauge');
    lines.push(`scheduler_feasible_ratio ${this.gauges.get('scheduler_feasible_ratio') ?? 0}`);

    // histogram
    lines.push(`# HELP ${this.histogramName} 调度运行耗时分布（ms）`);
    lines.push(`# TYPE ${this.histogramName} histogram`);
    lines.push(`${this.histogramName}_sum ${this.histogramSum}`);
    lines.push(`${this.histogramName}_count ${this.counters.get(`${this.histogramName}_sum_bucket`) ?? 0}`);
    for (const b of this.durationBucketsMs) {
      lines.push(`${this.histogramName}_bucket{le="${b}"} ${this.counters.get(`${this.histogramName}_bucket{le="${b}"}`) ?? 0}`);
    }
    lines.push(`${this.histogramName}_bucket{le="+Inf"} ${this.counters.get(`${this.histogramName}_bucket{le="+Inf"}`) ?? 0}`);

    return lines.join('\n') + '\n';
  }
}