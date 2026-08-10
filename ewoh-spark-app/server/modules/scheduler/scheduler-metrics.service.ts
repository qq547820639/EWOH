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

  // ---- Phase 4 / P4-OBS：生产可观测扩展（§二十四指标清单） ----

  /** 记录一次执行状态转换（execution.started/updated/completed/deviation 等）。 */
  recordExecutionTransition(status: string): void {
    this.inc(`scheduler_execution_transition_total{status="${status}"}`);
  }

  /** 记录一次执行偏差（execution deviation，带类型）。 */
  recordExecutionDeviation(deviationType?: string | null): void {
    this.inc(
      deviationType
        ? `scheduler_execution_deviation_total{type="${deviationType}"}`
        : 'scheduler_execution_deviation_total',
    );
  }

  /** 记录一次 SSE gap（Last-Event-ID 缺口触发 resync）。 */
  recordSseGap(reason?: string): void {
    this.inc(reason ? `scheduler_sse_gap_total{reason="${reason}"}` : 'scheduler_sse_gap_total');
  }

  // ---- Realtime 可观测（Task 3 / P2 增量：实时链路计数器） ----

  /** 记录一次 outbox 通知驱动的即时 poll（低延迟 wake-up 生效）。 */
  recordNotifyWakeup(): void { this.inc('scheduler_stream_notify_wakeup_total'); }

  /** 记录一次 listener 不可用/未启用时回退到轮询的 poll。 */
  recordPollFallback(): void { this.inc('scheduler_stream_poll_fallback_total'); }

  /** 记录一次 Postgres LISTEN 断线重连。 */
  recordListenerReconnect(): void { this.inc('scheduler_stream_listener_reconnect_total'); }

  /** 记录一次 SSE gap→resync（客户端需放弃增量全量拉取）。 */
  recordResync(): void { this.inc('scheduler_sse_resync_total'); }

  /** 记录一次 dispatch 成功/失败。 */
  recordDispatch(ok: boolean): void {
    this.inc(ok ? 'scheduler_dispatch_total' : 'scheduler_dispatch_failure_total');
  }

  /** 记录一次冲突产生（带类型）。 */
  recordConflictDetected(type?: string): void {
    this.inc(
      type
        ? `scheduler_conflict_total{type="${type}"}`
        : 'scheduler_conflict_total',
    );
  }

  /** 记录一次 Policy 事件（replay/shadow/activation）。 */
  recordPolicyEvent(kind: 'replay' | 'shadow' | 'activation' | 'gate'): void {
    this.inc(`scheduler_policy_${kind}_total`);
  }


  /** 记录一次 infeasible 求解结果。 */
  recordInfeasible(): void {
    this.inc('scheduler_solver_infeasible_total');
  }

  /** 记录一次 optimal 求解结果。 */
  recordOptimal(): void {
    this.inc('scheduler_solver_optimal_total');
  }

  /** 记录求解延迟（ms，直方图）。 */
  recordSolverLatencyMs(ms: number): void {
    this.gauges.set('scheduler_solver_latency_ms_last', ms);
    for (const b of this.durationBucketsMs) {
      if (ms <= b) this.inc(`scheduler_solver_latency_ms_bucket{le="${b}"}`);
    }
    this.inc('scheduler_solver_latency_ms_bucket{le="+Inf"}');
  }

  /** 记录一次资源预约冲突。 */
  recordReservationConflict(): void {
    this.inc('reservation_conflict_total');
  }

  /** 记录一次人工覆盖（manual override）。 */
  recordManualOverride(): void {
    this.inc('manual_override_total');
  }

  // ---- Phase 2 / P2-T3：Solver 可观测扩展 ----

  /** 记录最近一次求解的候选数量（gauge）。 */
  recordCandidateCount(count: number): void {
    this.gauges.set('scheduler_candidate_count', count);
  }

  /** 记录一次硬约束拒绝（缺失技能/证书/能力等不可派候选）。 */
  recordHardReject(count = 1): void {
    this.inc('scheduler_hard_reject_total', count);
  }

  /** 记录 station 决策命中次数（P1-4：station 作为决策变量被枚举并命中）。 */
  recordStationDecision(count = 1): void {
    this.inc('scheduler_station_decision_total', count);
  }

  /** 记录 changeover 次数（P1-4：任务实际被派往非默认工位产生换产成本）。 */
  recordChangeover(count = 1): void {
    this.inc('scheduler_changeover_total', count);
  }

  /** 记录最近一次局部重排的影响任务数（gauge）。 */
  recordPartialReplanAffected(count: number): void {
    this.gauges.set('scheduler_partial_replan_affected', count);
  }

  /** 记录一次方案 churn（相对基线改派的任务数）。 */
  recordPlanChurn(count: number): void {
    this.inc('scheduler_plan_churn_total', count);
  }

  /** 记录一次 Replan V2 风暴守卫抑制（08 §7）。 */
  recordReplanSuppressed(count = 1): void {
    this.inc('scheduler_replan_suppressed_total', count);
  }

  /** M04：记录一次非 MANUAL 触发的 replan run（replanTriggerCount KPI 数据源）。 */
  recordReplanTrigger(): void {
    this.inc('scheduler_replan_trigger_total');
  }

  /** M04：记录 replan 持久化阶段耗时（ms；recordRun.durationMs 已含 solve）。 */
  recordReplanPersistMs(ms: number): void {
    this.gauges.set('scheduler_replan_persist_ms_last', ms);
    this.inc('scheduler_replan_persist_ms_total', ms);
  }

  /** M04：记录一次 replan 的受影响任务占比（affected/可调度，gauge）。 */
  recordAffectedAssignmentRatio(ratio: number): void {
    this.gauges.set('scheduler_affected_assignment_ratio', ratio);
  }

  /** M04：记录一次 replan 的 unchanged assignment 占比（gauge）。 */
  recordUnchangedAssignmentRate(rate: number): void {
    this.gauges.set('scheduler_unchanged_assignment_rate', rate);
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

    // ---- Phase 2 / P2-T3 gauges ----
    for (const name of ['scheduler_candidate_count', 'scheduler_partial_replan_affected']) {
      lines.push(`# HELP ${name} 最近一次求解的候选数 / 局部重排影响任务数（gauge）`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${this.gauges.get(name) ?? 0}`);
    }

    // ---- Phase 2 / P2-T3 counters ----
    for (const [name, help] of [
      ['scheduler_hard_reject_total', '硬约束拒绝候选累计（缺失技能/证书/能力等）'],
      ['scheduler_plan_churn_total', '方案 churn 累计（相对基线改派任务数）'],
      ['scheduler_station_decision_total', 'station 决策命中累计（P1-4）'],
      ['scheduler_changeover_total', 'changeover 换产次数累计（P1-4）'],
    ] as Array<[string, string]>) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const variants = [...this.counters.entries()].filter(([k]) => k.startsWith(name));
      if (variants.length === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [key, val] of variants) {
          const rest = key.includes('{') ? key.slice(key.indexOf('{')) : '';
          lines.push(`${name}${rest} ${val}`);
        }
      }
    }

    // ---- Realtime 可观测（Task 3 / P2 增量）counters ----
    for (const [name, help] of [
      ['scheduler_stream_notify_wakeup_total', 'outbox NOTIFY 通知驱动的即时 poll 累计（低延迟 wake-up 生效）'],
      ['scheduler_stream_poll_fallback_total', 'listener 不可用/未启用时回退轮询的 poll 累计'],
      ['scheduler_stream_listener_reconnect_total', 'Postgres LISTEN 断线重连累计'],
      ['scheduler_sse_resync_total', 'SSE gap→resync 累计（客户端放弃增量全量拉取）'],
    ] as Array<[string, string]>) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const variants = [...this.counters.entries()].filter(([k]) => k.startsWith(name));
      if (variants.length === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [key, val] of variants) {
          const rest = key.includes('{') ? key.slice(key.indexOf('{')) : '';
          lines.push(`${name}${rest} ${val}`);
        }
      }
    }

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