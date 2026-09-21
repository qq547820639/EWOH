import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Ban,
  BellRing,
  CalendarClock,
  ClipboardList,
  Plus,
  Radar,
  Scale,
  RefreshCw,
  ShieldAlert,
  Sunrise,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { EventInfo, ExecutionListResponse } from '@shared/api.interface';
import type { SchedulingPlanV2, WorldSnapshotMaterial } from '@shared/scheduler';
import { getEventsPage, getOverview, getPlannedVsActual } from '../../api/dashboard';
import { getActivePlans, listExecutions } from '../../api/scheduler';
import { createHandover, getCurrentShift, listHandovers, listShifts, upsertShift } from '../../api/shift';
import { confirmDataQuality, getDataQualityConfirmations } from '../../api/dataQuality';
import { listNotifications } from '../../api/approvals';
import { listPerceptionFusion, sweepPerceptionFusion } from '../../api/perception';
import { getResponsibilityCoverage } from '../../api/deviceResponsibility';
import { queryKeys, tenantQueryKey } from '../../hooks/queryKeys';
import { OPERATIONAL_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { DataCredibility } from '../../components/DataCredibility';
import {
  buildAnomalyRows,
  buildPerceptionFusionView,
  buildPlannedVsActualView,
  buildQualityVerificationView,
  buildResponsibilityReadinessView,
  buildShiftKpis,
  handoverSummary,
  pageCredibility,
  perceptionSweepLabel,
  shiftBanner,
} from './shiftWorkbenchLogic';

const toneClasses = {
  neutral: 'border-border bg-muted text-foreground',
  positive: 'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground',
  warning: 'border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground',
  critical: 'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground',
} as const;

/**
 * 班次工作台（DR-2，standalone_074）：以"班"为第一视角组织当班事实——
 * 当前班次、当班异常（含数据质量人工确认）、待审批方案、执行偏差、
 * 物料缺口、交接班。进入页面即可回答：现在是什么班、发生了什么、
 * 需要谁处理、数据可不可信。
 */
const ShiftWorkbench = (): React.ReactElement => {
  const qc = useQueryClient();
  const [now] = useState(() => Date.now());

  const shiftQuery = useQuery({
    queryKey: queryKeys.shiftCurrent,
    queryFn: getCurrentShift,
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: 60_000,
  });
  const shiftsQuery = useQuery({
    queryKey: queryKeys.shiftDefinitions,
    queryFn: () => listShifts(true),
    staleTime: QUERY_STALE_TIME_MS,
  });
  /**
   * NO-52a：接班人核对——"下一班哪些设备没人负责"。
   * 交接时先看这个，缺口可以直接写进交接遗留事项（由人决定，平台不代填）。
   */
  const readinessQuery = useQuery({
    queryKey: queryKeys.deviceResponsibilityCoverage,
    queryFn: () => getResponsibilityCoverage(undefined),
    refetchInterval: 60000,
  });
  const readiness = buildResponsibilityReadinessView(readinessQuery.data);
  const handoversQuery = useQuery({
    queryKey: queryKeys.shiftHandovers,
    queryFn: () => listHandovers({ limit: 8 }),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const eventsQuery = useQuery<{ items: EventInfo[]; total: number }>({
    queryKey: queryKeys.factoryOperationsEvents(1, 10),
    queryFn: () => getEventsPage(10, undefined, 24, 0),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const plansQuery = useQuery<SchedulingPlanV2[]>({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const executionsQuery = useQuery<ExecutionListResponse>({
    queryKey: queryKeys.schedulerExecutions(),
    queryFn: () => listExecutions(),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const overviewQuery = useQuery({
    queryKey: queryKeys.factoryOperationsOverview,
    queryFn: getOverview,
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });

  const anomalyEvents = eventsQuery.data?.items ?? [];
  const dqQuery = useQuery({
    queryKey: queryKeys.dataQualityConfirmations(anomalyEvents.map((e) => e.eventId)),
    queryFn: () => getDataQualityConfirmations(anomalyEvents.map((e) => e.eventId)),
    enabled: anomalyEvents.length > 0,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // FE-1：班次读失败时横幅必须说"读取失败"，绝不落回"当前不在任何班次窗口内"
  // （后者会让人去重新登记班次定义，而真相是"没读到"）。
  const banner = shiftBanner(
    shiftQuery.data?.current,
    shiftQuery.data?.next,
    shiftQuery.isLoading,
    shiftQuery.isError,
  );
  const materials: WorldSnapshotMaterial[] = (overviewQuery.data as { materials?: WorldSnapshotMaterial[] } | undefined)?.materials ?? [];
  const kpis = useMemo(
    () =>
      buildShiftKpis({
        events: anomalyEvents,
        plans: plansQuery.data,
        executions: executionsQuery.data,
        materials,
        // FE-1：403/500 时数组退化为 undefined，KPI 会显示 0；用显式标记把数字改成"—"。
        plansUnavailable: plansQuery.isError,
        executionsUnavailable: executionsQuery.isError,
        // FE-1（2026-09-13 补口）：events / overview 读失败同样不得让 KPI 伪称
        // "0 条异常"或"无缺口行（未接入 ERP）"——overview 403 正是 workshop_lead
        // （本页默认落地角色）打开本页时的常态。
        eventsUnavailable: eventsQuery.isError,
        materialsUnavailable: overviewQuery.isError,
      }),
    [anomalyEvents, plansQuery.data, plansQuery.isError, executionsQuery.data, executionsQuery.isError, materials, eventsQuery.isError, overviewQuery.isError],
  );
  const anomalyRows = useMemo(
    () => buildAnomalyRows(anomalyEvents, dqQuery.data ?? []),
    [anomalyEvents, dqQuery.data],
  );

  const dqMutation = useMutation({
    mutationFn: (input: { eventId: string; verdict: 'confirmed' | 'contested' }) =>
      confirmDataQuality(input),
    onSuccess: () => {
      // 失效必须命中真实缓存键：确认查询键是 [org, 'data-quality-confirmations',
      // eventIds]（tenantQueryKey 租户分片）。失效 ['data-quality'] 前缀匹配不到
      // 任何查询 → 判定提交成功后按钮原地不动，用户会重复提交同一判定。
      void qc.invalidateQueries({ queryKey: tenantQueryKey('data-quality-confirmations') });
      void qc.invalidateQueries({ queryKey: queryKeys.factoryOperationsEvents(1, 10) });
      // 判定会把同源的"待核实提醒"落到终态（NO-53a）→ 提醒列表必须重取。
      void qc.invalidateQueries({ queryKey: queryKeys.notificationsPending });
    },
  });

  /**
   * NO-53a：数据质量"待核实提醒"是否真的叫到了人。
   * 摄入侧开了告警，但提醒有没有发出去、发给了谁、发了多久没人应——这是
   * "告警可见"和"有人被叫到"的区别，必须能看到投递失败与收件人缺口。
   */
  const dqNotificationsQuery = useQuery({
    queryKey: queryKeys.notificationsPending,
    queryFn: () => listNotifications('pending'),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const dqVerification = buildQualityVerificationView(dqNotificationsQuery.data, { now });

  /**
   * NO-56a：多模态感知融合——"现在人在哪、姿态如何、这个结论可信吗"。
   * 低置信度/有冲突时页面必须说清"不得据此生成强建议"（§5 规则 5）。
   */
  const fusionQuery = useQuery({
    queryKey: queryKeys.perceptionFusion,
    queryFn: () => listPerceptionFusion({ limit: 20 }),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const [fusionNote, setFusionNote] = useState<string | null>(null);
  const fusionSweep = useMutation({
    mutationFn: () => sweepPerceptionFusion({ windowMinutes: 5, bucketMinutes: 5 }),
    onSuccess: (result) => {
      setFusionNote(perceptionSweepLabel(result));
      void qc.invalidateQueries({ queryKey: queryKeys.perceptionFusion });
    },
  });
  const fusionViews = (fusionQuery.data ?? []).map((item) => ({
    fused: item,
    view: buildPerceptionFusionView(item),
  }));

  /**
   * NO-57b：预计 vs 实际 对账——"排产/预测的口径到底准不准"。
   * 样本不足时页面必须写"证据不足、不给比率"（不显示 0%）。
   */
  const pvaQuery = useQuery({
    queryKey: queryKeys.schedulerPlannedVsActual(30),
    queryFn: () => getPlannedVsActual(30),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const pva = buildPlannedVsActualView(pvaQuery.data);

  const refreshAll = () => {
    void shiftQuery.refetch();
    void eventsQuery.refetch();
    void plansQuery.refetch();
    void executionsQuery.refetch();
    void handoversQuery.refetch();
    void overviewQuery.refetch();
    void dqNotificationsQuery.refetch();
    void fusionQuery.refetch();
    void pvaQuery.refetch();
  };
  const isRefreshing =
    shiftQuery.isFetching || eventsQuery.isFetching || plansQuery.isFetching || handoversQuery.isFetching;

  const [handoverForm, setHandoverForm] = useState({ shiftId: '', toUserId: '', openTitle: '', notes: '' });
  const handoverMutation = useMutation({
    mutationFn: () =>
      createHandover({
        shiftId: handoverForm.shiftId,
        toUserId: handoverForm.toUserId,
        openItems: handoverForm.openTitle.trim()
          ? [{ title: handoverForm.openTitle.trim(), severity: 'warning' }]
          : [],
        notes: handoverForm.notes.trim() || null,
      }),
    onSuccess: () => {
      setHandoverForm({ shiftId: '', toUserId: '', openTitle: '', notes: '' });
      void qc.invalidateQueries({ queryKey: queryKeys.shiftHandovers });
    },
  });

  const [shiftForm, setShiftForm] = useState({ name: '', startTime: '', endTime: '' });
  const shiftFormMutation = useMutation({
    mutationFn: () =>
      upsertShift({
        name: shiftForm.name.trim(),
        startTime: shiftForm.startTime,
        endTime: shiftForm.endTime,
      }),
    onSuccess: () => {
      setShiftForm({ name: '', startTime: '', endTime: '' });
      void qc.invalidateQueries({ queryKey: queryKeys.shiftDefinitions });
      void qc.invalidateQueries({ queryKey: queryKeys.shiftCurrent });
    },
  });

  return (
    <div className="flex min-h-full flex-col gap-6 p-4 sm:p-6" data-testid="shift-workbench">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sunrise className="size-4" /> EWOH · 班次工作台
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">{banner.label}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{banner.detail}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={refreshAll} disabled={isRefreshing}>
          <RefreshCw className="size-3" />刷新
        </Button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="当班汇总">
        {kpis.map((kpi) => (
          <div key={kpi.key} data-testid={`kpi-${kpi.key}`} className={`rounded-xl border p-4 ${toneClasses[kpi.tone]}`}>
            <span className="text-xs font-medium opacity-80">{kpi.label}</span>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{kpi.value}</p>
            <p className="mt-1 text-xs leading-5">{kpi.detail}</p>
          </div>
        ))}
      </section>

      <div className="grid min-h-0 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,0.9fr)]">
        <div className="flex flex-col gap-6">
          <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-labelledby="anomaly-title">
            <div className="flex items-center justify-between gap-2">
              <h2 id="anomaly-title" className="flex items-center gap-2 text-sm font-semibold">
                <ShieldAlert className="size-4" /> 当班异常与数据质量
              </h2>
              <Link to="/alerts" className="text-xs font-medium text-primary hover:underline">全部告警</Link>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              闭环第②步：确认数据可信再决策。confirmed=可信可用于决策；contested=不可信，相关决策需复核。
            </p>
            <ul className="mt-3 divide-y divide-border">
              {/* FE-1：事件读失败时"近 24h 无 open 异常"是伪造事实（读不到 ≠ 没有异常）。 */}
              {eventsQuery.isError && (
                <li className="py-3 text-sm text-risk-degraded-foreground" role="alert" data-testid="anomaly-error">
                  异常事件读取失败（
                  {eventsQuery.error instanceof Error ? eventsQuery.error.message : '原因未知'}）
                  ——无法判断近 24h 有没有 open 异常。
                </li>
              )}
              {anomalyRows.length === 0 && !eventsQuery.isError && (
                <li className="py-3 text-sm text-muted-foreground">近 24h 无 open 异常（无数据 ≠ 现场安全，见可信度面板）</li>
              )}
              {anomalyRows.map((row) => (
                <li key={row.eventId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{row.severity}</Badge>
                      <span className="truncate text-sm font-medium" title={row.title}>{row.title}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.occurredAt ? new Date(row.occurredAt).toLocaleString('zh-CN') : '时间未知'}
                      {row.sourceType ? ` · 来源 ${row.sourceType}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {row.dqVerdict ? (
                      <Badge variant={row.dqVerdict === 'confirmed' ? 'default' : 'destructive'}>
                        {row.dqVerdict === 'confirmed' ? '已确认可信' : '已被质疑'}
                      </Badge>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={dqMutation.isPending}
                          onClick={() => dqMutation.mutate({ eventId: row.eventId, verdict: 'confirmed' })}
                        >
                          <BadgeCheck className="size-3" />确认可信
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={dqMutation.isPending}
                          onClick={() => dqMutation.mutate({ eventId: row.eventId, verdict: 'contested' })}
                        >
                          <Ban className="size-3" />质疑
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {dqMutation.isError && (
              <p className="mt-2 text-xs text-risk-blocked-foreground" role="alert">
                确认提交失败：{dqMutation.error instanceof Error ? dqMutation.error.message : '未知错误'}
              </p>
            )}
          </section>

          <section
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
            aria-labelledby="perception-fusion-title"
            data-testid="perception-fusion"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="perception-fusion-title" className="flex items-center gap-2 text-sm font-semibold">
                <Radar className="size-4" /> 感知融合（人在哪 · 姿态 · 可信吗）
              </h2>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={fusionSweep.isPending}
                onClick={() => fusionSweep.mutate()}
                data-testid="perception-fusion-sweep"
              >
                融合一次（近 5 分钟）
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              多源（UWB 定位 / 外骨骼 IMU / 视觉 / 工位语义 / 任务上下文）加权融合，
              规则可解释：同工位才算交叉验证一致；不一致**记录冲突而不是丢掉某一源**；
              缺源则降级并降置信度。**低置信度或有冲突时，上游不得据此生成强建议。**
            </p>
            {fusionNote && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="perception-fusion-note">{fusionNote}</p>
            )}
            {fusionSweep.isError && (
              <p className="mt-2 text-xs text-risk-blocked-foreground" role="alert">
                融合失败：{fusionSweep.error instanceof Error ? fusionSweep.error.message : '未知错误'}
              </p>
            )}
            {fusionQuery.isError && (
              <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert" data-testid="perception-fusion-error">
                融合快照读取失败（
                {fusionQuery.error instanceof Error ? fusionQuery.error.message : '原因未知'}）
                ——这里不会显示成"现场没人"。
              </p>
            )}
            <ul className="mt-3 divide-y divide-border">
              {!fusionQuery.isLoading && !fusionQuery.isError && fusionViews.length === 0 && (
                <li className="py-3 text-sm text-muted-foreground" data-testid="perception-fusion-empty">
                  暂无融合快照：点"融合一次"，或确认边缘是否在上报定位/遥测（**没有快照 ≠ 现场没有异常**）
                </li>
              )}
              {fusionViews.map(({ fused, view }) => (
                <li key={fused.subjectId} className="py-2.5" data-testid="perception-fusion-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={view.agreementTone === 'critical' ? 'destructive' : 'outline'}>
                          {view.agreementLabel}
                        </Badge>
                        <span className="truncate text-sm font-medium">{view.subjectId}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground" data-testid="perception-fusion-state">
                        {view.stationLabel} · {view.postureLabel} · {view.confidenceLabel}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground" data-testid="perception-fusion-sources">
                        {view.sourceLabel}
                        {view.missingLabel ? ` · ${view.missingLabel}` : ''}
                        {view.degradedLabel ? ` · ${view.degradedLabel}` : ''}
                      </p>
                    </div>
                  </div>
                  {view.conflictLabels.length > 0 && (
                    <ul className="mt-1 space-y-0.5" data-testid="perception-fusion-conflicts">
                      {view.conflictLabels.map((label) => (
                        <li key={label} className="text-xs text-risk-blocked-foreground">· {label}</li>
                      ))}
                    </ul>
                  )}
                  {view.excludedLabels.length > 0 && (
                    <ul className="mt-1 space-y-0.5" data-testid="perception-fusion-excluded">
                      {view.excludedLabels.map((label) => (
                        <li key={label} className="text-[11px] text-muted-foreground">· 已排除证据 {label}</li>
                      ))}
                    </ul>
                  )}
                  <p
                    className={`mt-1 text-[11px] ${view.notes.length > 0 ? 'text-muted-foreground' : 'text-muted-foreground'}`}
                    data-testid="perception-fusion-advice"
                  >
                    {view.adviceLabel}
                  </p>
                  {view.notes.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5" data-testid="perception-fusion-notes">
                      {view.notes.map((note) => (
                        <li key={note} className="text-[11px] text-muted-foreground">· {note}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
            aria-labelledby="planned-vs-actual-title"
            data-testid="planned-vs-actual"
          >
            <h2 id="planned-vs-actual-title" className="flex items-center gap-2 text-sm font-semibold">
              <Scale className="size-4" /> 预计 vs 实际（执行对账）
            </h2>
            {pvaQuery.isError ? (
              <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert" data-testid="planned-vs-actual-error">
                对账数据读取失败（
                {pvaQuery.error instanceof Error ? pvaQuery.error.message : '原因未知'}）
                ——这里不会显示成"执行很准时"。
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-muted-foreground" data-testid="planned-vs-actual-scope">
                  {pva.scopeLabel}
                </p>
                <p
                  className={`mt-1 text-xs ${pva.hasEvidence ? 'text-foreground' : 'text-risk-degraded-foreground'}`}
                  data-testid="planned-vs-actual-rate"
                >
                  {pva.rateLabel}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="planned-vs-actual-counts">
                  {pva.countLabel}
                </p>
                {pva.biasNote && (
                  <p className="mt-1 text-xs text-risk-degraded-foreground" data-testid="planned-vs-actual-bias">
                    {pva.biasNote}
                  </p>
                )}
                {pva.reasonLabels.length > 0 && (
                  <ul className="mt-1 space-y-0.5" data-testid="planned-vs-actual-reasons">
                    {pva.reasonLabels.map((label) => (
                      <li key={label} className="text-[11px] text-muted-foreground">· {label}</li>
                    ))}
                  </ul>
                )}
                {pva.deviationLabels.length > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground" data-testid="planned-vs-actual-deviations">
                    偏差类型：{pva.deviationLabels.join('、')}
                  </p>
                )}
                {pva.notes.length > 0 && (
                  <ul className="mt-1 space-y-0.5" data-testid="planned-vs-actual-notes">
                    {pva.notes.map((note) => (
                      <li key={note} className="text-[11px] text-muted-foreground">· {note}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
            aria-labelledby="dq-verify-title"
            data-testid="data-quality-verification"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id="dq-verify-title" className="flex items-center gap-2 text-sm font-semibold">
                <BellRing className="size-4" /> 待核实数据提醒（是否叫到了人）
              </h2>
              <Badge variant={dqVerification.needsAttention ? 'destructive' : 'outline'}>
                未处置 {dqVerification.pendingNotificationCount}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              告警"可见"≠"有人被叫到"。这里显示提醒发给了谁、等了多久、有没有投递失败；
              核实判定由人做出（确认可信 / 质疑），平台不代判、不自动改数。
            </p>
            {dqNotificationsQuery.isError ? (
              <p className="mt-2 text-xs text-risk-degraded-foreground" data-testid="dq-verification-error">
                提醒数据读取失败（
                {dqNotificationsQuery.error instanceof Error ? dqNotificationsQuery.error.message : '原因未知'}）
                ——这里不会显示成"已经叫到人"。
              </p>
            ) : (
              <>
                <ul className="mt-3 divide-y divide-border">
                  {dqVerification.rows.length === 0 && (
                    <li className="py-3 text-sm text-muted-foreground" data-testid="dq-verification-empty">
                      当前没有未处置的数据质量提醒（无提醒 ≠ 数据可信，见可信度面板）
                    </li>
                  )}
                  {dqVerification.rows.map((row) => (
                    <li key={row.notificationIds[0]} className="py-2.5" data-testid="dq-verification-row">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{row.severity || '严重度未知'}</Badge>
                            <span className="truncate text-sm font-medium" title={row.title}>{row.title}</span>
                          </div>
                          {row.body && <p className="mt-0.5 text-xs text-muted-foreground">{row.body}</p>}
                          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="dq-verification-recipients">
                            叫到：{row.recipients.join('、')}（{row.channels.join('/')}）· {row.waitingLabel}
                            {row.readCount > 0 ? ` · 已读 ${row.readCount} 条` : ''}
                            {row.alertEventId ? '' : ' · 未关联源事件号'}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {row.failedDeliveryCount > 0 && (
                            <Badge variant="destructive" data-testid="dq-verification-failed">
                              投递失败 {row.failedDeliveryCount}
                            </Badge>
                          )}
                          {row.alertEventId ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={dqMutation.isPending}
                                onClick={() => dqMutation.mutate({ eventId: row.alertEventId as string, verdict: 'confirmed' })}
                              >
                                <BadgeCheck className="size-3" />确认可信
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={dqMutation.isPending}
                                onClick={() => dqMutation.mutate({ eventId: row.alertEventId as string, verdict: 'contested' })}
                              >
                                <Ban className="size-3" />质疑
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-risk-degraded-foreground">无法回写判定</span>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {dqVerification.notes.length > 0 && (
                  <ul className="mt-2 space-y-0.5" data-testid="dq-verification-notes">
                    {dqVerification.notes.map((note) => (
                      <li key={note} className="text-[11px] text-muted-foreground">· {note}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-labelledby="plans-title">
            <div className="flex items-center justify-between gap-2">
              <h2 id="plans-title" className="flex items-center gap-2 text-sm font-semibold">
                <CalendarClock className="size-4" /> 待审批与执行中方案
              </h2>
              <Link to="/scheduling" className="text-xs font-medium text-primary hover:underline">排产调度</Link>
            </div>
            {/* FE-1：方案读失败（如 safety_admin 不在 /api/scheduler 角色集 → 403）时，
                绝不落回"当前无待审批/执行中方案"——那是把"没读到"说成"没有"。 */}
            {plansQuery.isError ? (
              <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert" data-testid="plans-error">
                方案数据读取失败（
                {plansQuery.error instanceof Error ? plansQuery.error.message : '原因未知'}）
                ——无法判断有没有待批/执行中方案。
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {(plansQuery.data ?? [])
                  .filter((p) => p.status === 'draft' || p.status === 'approved' || p.status === 'dispatched' || p.status === 'executing')
                  .slice(0, 6)
                  .map((plan) => (
                    <li key={plan.planId} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2.5">
                      <div className="min-w-0">
                        <Link to={`/o/scheduling_plan/${encodeURIComponent(plan.planId)}`} className="truncate text-sm font-medium hover:underline">
                          {plan.planName ?? plan.planId}
                        </Link>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {plan.assignments.length} 项分配 · 触发 {plan.trigger.type}
                          {plan.solverStatus ? ` · ${plan.solverStatus}` : ''}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {plan.status === 'draft' ? '待审批' : plan.status === 'approved' ? '已审批' : plan.status === 'dispatched' ? '已下发' : '执行中'}
                      </Badge>
                    </li>
                  ))}
                {(plansQuery.data ?? []).filter(
                  (p) => p.status === 'draft' || p.status === 'approved' || p.status === 'dispatched' || p.status === 'executing',
                ).length === 0 && (
                  <li className="py-2 text-sm text-muted-foreground">当前无待审批/执行中方案</li>
                )}
              </ul>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-6">
          {/* NO-52a：接班人核对——缺口显式，可一键写进交接遗留事项（人决定是否写） */}
          <section
            className="rounded-xl border border-border bg-card p-4 shadow-sm"
            aria-labelledby="responsibility-readiness-title"
            data-testid="responsibility-readiness"
          >
            <h2 id="responsibility-readiness-title" className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardList className="size-4" /> 接班人核对（设备责任人）
            </h2>
            {readinessQuery.isError ? (
              <p className="mt-2 text-xs text-risk-degraded-foreground" data-testid="responsibility-readiness-error">
                责任人核对数据读取失败（
                {readinessQuery.error instanceof Error ? readinessQuery.error.message : '原因未知'}）
                ——这里不会显示成"无人负责"。
              </p>
            ) : (
              <>
                <p className="mt-2 text-xs text-muted-foreground" data-testid="responsibility-readiness-scope">
                  {readiness.scopeLabel}
                </p>
                <p
                  className={`mt-1 text-xs ${readiness.needsAttention ? 'text-risk-degraded-foreground' : 'text-foreground'}`}
                  data-testid="responsibility-readiness-summary"
                >
                  {readiness.summaryLabel}
                </p>
                {readiness.shiftUnknownNote && (
                  <p className="mt-1 text-xs text-risk-degraded-foreground" data-testid="responsibility-readiness-shift-unknown">
                    {readiness.shiftUnknownNote}
                  </p>
                )}
                {readiness.gapRows.length > 0 && (
                  <ul className="mt-2 space-y-1" data-testid="responsibility-readiness-gaps">
                    {readiness.gapRows.slice(0, 5).map((row) => (
                      <li key={row.deviceId} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs">
                        <span className="text-foreground">{row.deviceId}</span>
                        <span className="text-muted-foreground">{row.detail}</span>
                      </li>
                    ))}
                    {readiness.gapRows.length > 5 && (
                      <li className="text-[11px] text-muted-foreground">…另有 {readiness.gapRows.length - 5} 台</li>
                    )}
                  </ul>
                )}
                {readiness.needsAttention && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    data-testid="responsibility-readiness-to-open-items"
                    onClick={() =>
                      setHandoverForm((f) => ({
                        ...f,
                        openTitle:
                          `接班人核对：${readiness.gapRows.length} 台设备本班无人负责`
                          + (readiness.uncovered > 0 ? `、${readiness.uncovered} 台未登记责任人` : '')
                          + '（请接班后补齐）',
                      }))
                    }
                  >
                    写进交接遗留事项
                  </Button>
                )}
                {readiness.notes.length > 0 && (
                  <ul className="mt-2 space-y-0.5" data-testid="responsibility-readiness-notes">
                    {readiness.notes.map((note) => (
                      <li key={note} className="text-[11px] text-muted-foreground">· {note}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-labelledby="handover-title">
            <h2 id="handover-title" className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardList className="size-4" /> 交接班
            </h2>
            <div className="mt-3 space-y-1.5">
              {(handoversQuery.data ?? []).slice(0, 5).map((h) => (
                <div key={h.handoverId} className="rounded-lg border border-border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{h.shiftDate} · {h.shiftId}</span>
                    <Badge variant={h.status === 'confirmed' ? 'outline' : 'secondary'}>{h.status === 'confirmed' ? '已确认' : '待确认'}</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{handoverSummary(h)}</p>
                </div>
              ))}
              {/* FE-1：读失败 ≠ 没有交接记录（同屏还可能让班次下拉变空）。 */}
              {handoversQuery.isError && (
                <p className="text-sm text-risk-degraded-foreground" role="alert" data-testid="handovers-error">
                  交接记录读取失败（
                  {handoversQuery.error instanceof Error ? handoversQuery.error.message : '原因未知'}）
                  ——无法判断有没有交接记录。
                </p>
              )}
              {(handoversQuery.data ?? []).length === 0 && !handoversQuery.isError && (
                <p className="text-sm text-muted-foreground">暂无交接记录</p>
              )}
            </div>
            <form
              className="mt-4 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (handoverForm.shiftId && handoverForm.toUserId) handoverMutation.mutate();
              }}
            >
              <select
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                value={handoverForm.shiftId}
                onChange={(e) => setHandoverForm((f) => ({ ...f, shiftId: e.target.value }))}
                aria-label="交接班次"
              >
                <option value="">选择班次…</option>
                {(shiftsQuery.data ?? []).map((s) => (
                  <option key={s.shiftId} value={s.shiftId}>{s.name}（{s.startTime}–{s.endTime}）</option>
                ))}
              </select>
              <input
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                placeholder="接班人用户 ID"
                value={handoverForm.toUserId}
                onChange={(e) => setHandoverForm((f) => ({ ...f, toUserId: e.target.value }))}
              />
              <input
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                placeholder="遗留事项（可选，如：3 号工位设备待复核）"
                value={handoverForm.openTitle}
                onChange={(e) => setHandoverForm((f) => ({ ...f, openTitle: e.target.value }))}
              />
              <Button type="submit" size="sm" disabled={handoverMutation.isPending || !handoverForm.shiftId || !handoverForm.toUserId}>
                登记交接
              </Button>
              {handoverMutation.isError && (
                <p className="text-xs text-risk-blocked-foreground" role="alert">
                  交接登记失败：{handoverMutation.error instanceof Error ? handoverMutation.error.message : '未知错误'}
                </p>
              )}
            </form>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-label="数据可信度">
            <h2 className="text-sm font-semibold">本页数据可信度</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              结构化可信度展示（UX-001）：来源/采集时间/完整性/置信度/可用于决策。
            </p>
            <DataCredibility
              className="mt-3"
              info={pageCredibility({
                eventsUpdatedAt: eventsQuery.dataUpdatedAt,
                plansUpdatedAt: plansQuery.dataUpdatedAt,
                now,
              })}
            />
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-labelledby="shift-defs-title">
            <h2 id="shift-defs-title" className="text-sm font-semibold">班次定义</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(shiftsQuery.data ?? []).map((s) => (
                <Badge key={s.shiftId} variant="outline">
                  {s.name} {s.startTime}–{s.endTime}{s.crossesMidnight ? '（跨零点）' : ''}
                </Badge>
              ))}
              {/* FE-1：班次定义读失败 ≠ 未登记班次——后者会把横幅的"读不到"洗成"没登记"。 */}
              {shiftsQuery.isError && (
                <p className="text-xs text-risk-degraded-foreground" role="alert" data-testid="shift-defs-error">
                  班次定义读取失败（
                  {shiftsQuery.error instanceof Error ? shiftsQuery.error.message : '原因未知'}）
                  ——无法判断班次是否已登记。
                </p>
              )}
              {(shiftsQuery.data ?? []).length === 0 && !shiftsQuery.isError && (
                <p className="text-xs text-muted-foreground">未登记班次——当前班次将显示"不在任何班次窗口内"</p>
              )}
            </div>
            <form
              className="mt-3 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (shiftForm.name && shiftForm.startTime && shiftForm.endTime) shiftFormMutation.mutate();
              }}
            >
              <input
                className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                placeholder="班次名（如 早班）"
                value={shiftForm.name}
                onChange={(e) => setShiftForm((f) => ({ ...f, name: e.target.value }))}
              />
              <input
                className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                placeholder="08:00"
                value={shiftForm.startTime}
                onChange={(e) => setShiftForm((f) => ({ ...f, startTime: e.target.value }))}
                aria-label="开始时间 HH:mm"
              />
              <input
                className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                placeholder="16:00"
                value={shiftForm.endTime}
                onChange={(e) => setShiftForm((f) => ({ ...f, endTime: e.target.value }))}
                aria-label="结束时间 HH:mm"
              />
              <Button type="submit" size="sm" variant="outline" disabled={shiftFormMutation.isPending}>
                <Plus className="size-3" />登记
              </Button>
            </form>
            {shiftFormMutation.isError && (
              <p className="mt-2 text-xs text-risk-blocked-foreground" role="alert">
                班次登记失败：{shiftFormMutation.error instanceof Error ? shiftFormMutation.error.message : '未知错误'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default ShiftWorkbench;
