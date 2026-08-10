import { SchedulerMetricsService } from '../scheduler-metrics.service';

describe('SchedulerMetricsService（Phase 3.2 可观测指标）', () => {
  let metrics: SchedulerMetricsService;

  beforeEach(() => {
    metrics = new SchedulerMetricsService();
    metrics.reset();
  });

  it('recordRun 递增 scheduler_run_total 并记录直方图与 feasible_ratio', () => {
    metrics.recordRun({ durationMs: 300, feasible: true, solverVersion: 'heuristic-v2', solverStatus: 'OPTIMAL' });
    metrics.recordRun({ durationMs: 1200, feasible: false, solverVersion: 'cpsat-v1', solverStatus: 'FEASIBLE' });

    const s = metrics.snapshot();
    expect(s['scheduler_run_total{solver_version="heuristic-v2",status="OPTIMAL"}']).toBe(1);
    expect(s['scheduler_run_total{solver_version="heuristic-v2",status="OPTIMAL",feasible="true"}']).toBe(1);
    expect(s['scheduler_run_total{solver_version="cpsat-v1",status="FEASIBLE",feasible="false"}']).toBe(1);
    // 直方图：300ms 落在 250 与 500 桶之间；1200ms 落在 1000-2000 之间
    expect(s['scheduler_run_duration_ms_sum']).toBe(300 + 1200);
    expect(s['scheduler_run_duration_ms_bucket{le="250"}'] ?? 0).toBe(0);
    expect(s['scheduler_run_duration_ms_bucket{le="500"}']).toBe(1);
    expect(s['scheduler_run_duration_ms_bucket{le="1000"}']).toBe(1);
    expect(s['scheduler_run_duration_ms_bucket{le="+Inf"}']).toBe(2);
    // gauge 取最近一次
    expect(s['scheduler_feasible_ratio']).toBe(0);
  });

  it('各 record* 方法正确递增对应计数器（含 planId 标签变体）', () => {
    metrics.recordSolverTimeout();
    metrics.recordFallback();
    metrics.recordPlanApproved('P-1');
    metrics.recordPlanApproved('P-1');
    metrics.recordPlanRejected('P-2');
    metrics.recordPlanStale('P-3');
    metrics.recordReplan();
    metrics.recordReservationConflict();
    metrics.recordManualOverride();

    const s = metrics.snapshot();
    expect(s['scheduler_solver_timeout_total']).toBe(1);
    expect(s['scheduler_fallback_total']).toBe(1);
    expect(s['plan_approved_total{plan_id="P-1"}']).toBe(2);
    expect(s['plan_rejected_total{plan_id="P-2"}']).toBe(1);
    expect(s['plan_stale_total{plan_id="P-3"}']).toBe(1);
    expect(s['replan_total']).toBe(1);
    expect(s['reservation_conflict_total']).toBe(1);
    expect(s['manual_override_total']).toBe(1);
  });

  it('reset 清空全部指标', () => {
    metrics.recordRun({ durationMs: 100, feasible: true });
    metrics.recordFallback();
    metrics.reset();
    expect(metrics.snapshot()).toEqual({});
  });

  it('renderMetrics 输出合法 Prometheus text（含 HELP/TYPE/直方图）', () => {
    metrics.recordRun({ durationMs: 80, feasible: true, solverVersion: 'heuristic-v2', solverStatus: 'OPTIMAL' });
    metrics.recordFallback();
    metrics.recordPlanApproved('P-1');

    const text = metrics.renderMetrics();
    expect(text).toContain('# HELP scheduler_run_total');
    expect(text).toContain('# TYPE scheduler_run_total counter');
    expect(text).toMatch(/scheduler_run_total\{solver_version="heuristic-v2",status="OPTIMAL"\} 1/);
    expect(text).toContain('# TYPE scheduler_run_duration_ms histogram');
    expect(text).toMatch(/scheduler_run_duration_ms_sum 80/);
    expect(text).toMatch(/scheduler_run_duration_ms_bucket\{le="100"\} 1/);
    expect(text).toContain('scheduler_fallback_total 1');
    expect(text).toContain('# TYPE scheduler_feasible_ratio gauge');
    expect(text).toMatch(/scheduler_feasible_ratio 1/);
  });

  it('空状态渲染时不抛错且输出 0 基线', () => {
    const text = metrics.renderMetrics();
    expect(text).toContain('scheduler_run_total 0');
    expect(text).toContain('scheduler_solver_timeout_total 0');
    expect(text).toContain('scheduler_stream_notify_wakeup_total 0');
    expect(text).toContain('scheduler_stream_poll_fallback_total 0');
    expect(text).toContain('scheduler_stream_listener_reconnect_total 0');
    expect(text).toContain('scheduler_sse_resync_total 0');
    expect(text).toBeTruthy();
  });

  it('Realtime 指标：notify wakeup / poll fallback / listener reconnect / resync 正确记录', () => {
    metrics.recordNotifyWakeup();
    metrics.recordNotifyWakeup();
    metrics.recordPollFallback();
    metrics.recordListenerReconnect();
    metrics.recordResync();

    const s = metrics.snapshot();
    expect(s['scheduler_stream_notify_wakeup_total']).toBe(2);
    expect(s['scheduler_stream_poll_fallback_total']).toBe(1);
    expect(s['scheduler_stream_listener_reconnect_total']).toBe(1);
    expect(s['scheduler_sse_resync_total']).toBe(1);

    const text = metrics.renderMetrics();
    expect(text).toContain('# TYPE scheduler_stream_notify_wakeup_total counter');
    expect(text).toContain('# TYPE scheduler_stream_poll_fallback_total counter');
    expect(text).toContain('# TYPE scheduler_stream_listener_reconnect_total counter');
    expect(text).toContain('# TYPE scheduler_sse_resync_total counter');
    expect(text).toMatch(/scheduler_stream_notify_wakeup_total 2/);
    expect(text).toMatch(/scheduler_stream_poll_fallback_total 1/);
    expect(text).toMatch(/scheduler_stream_listener_reconnect_total 1/);
    expect(text).toMatch(/scheduler_sse_resync_total 1/);
  });

  it('P2-T3：候选数/硬拒绝/影响数/churn 指标正确记录', () => {
    metrics.recordCandidateCount(12);
    metrics.recordHardReject(3);
    metrics.recordPartialReplanAffected(5);
    metrics.recordPlanChurn(2);
    metrics.recordPlanChurn(1);

    const s = metrics.snapshot();
    expect(s['scheduler_candidate_count']).toBe(12);
    expect(s['scheduler_hard_reject_total']).toBe(3);
    expect(s['scheduler_partial_replan_affected']).toBe(5);
    expect(s['scheduler_plan_churn_total']).toBe(3);

    const text = metrics.renderMetrics();
    expect(text).toContain('# TYPE scheduler_candidate_count gauge');
    expect(text).toMatch(/scheduler_candidate_count 12/);
    expect(text).toMatch(/scheduler_hard_reject_total 3/);
    expect(text).toMatch(/scheduler_plan_churn_total 3/);
    expect(text).toMatch(/scheduler_partial_replan_affected 5/);
  });

  it('P1-4：station_decision / changeover 指标正确记录（T05 埋点）', () => {
    metrics.recordStationDecision(4);
    metrics.recordChangeover(2);
    metrics.recordChangeover(1);

    const s = metrics.snapshot();
    expect(s['scheduler_station_decision_total']).toBe(4);
    expect(s['scheduler_changeover_total']).toBe(3);

    const text = metrics.renderMetrics();
    expect(text).toContain('# TYPE scheduler_station_decision_total counter');
    expect(text).toContain('# TYPE scheduler_changeover_total counter');
    expect(text).toMatch(/scheduler_station_decision_total 4/);
    expect(text).toMatch(/scheduler_changeover_total 3/);
  });
});