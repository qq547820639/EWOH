import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Factory,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
  WifiOff,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { EventInfo, OverviewStats } from '@shared/api.interface';
import type { SchedulingPlanV2 } from '@shared/scheduler';
import { getEventsPage, getOverview } from '../../api/dashboard';
import { getActivePlans } from '../../api/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import { OPERATIONAL_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { getAuthUser } from '../../lib/auth';
import { getAllowedRoles, hasRoleAccess } from '../../lib/navigation';
import { ExecutionFeedback } from './ExecutionFeedback';
import {
  buildAttentionItems,
  buildFactoryOperationsKpis,
  formatFreshness,
  isFactoryDataCurrent,
} from './factoryOperationsLogic';

const toneClasses = {
  neutral: 'border-border bg-muted text-foreground',
  positive: 'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground',
  warning: 'border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground',
  critical: 'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground',
} as const;

function SectionLink({ to, children }: { to: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
      {children}
      <ArrowRight className="size-3" />
    </Link>
  );
}

function LoadingLine({ label }: { label: string }): React.ReactElement {
  return <p className="text-sm text-muted-foreground">{label}加载中…</p>;
}

function ErrorLine({ label, onRetry }: { label: string; onRetry: () => void }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-risk-blocked-foreground">
      <span>{label}加载失败</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="size-3" />重试
      </Button>
    </div>
  );
}

const FactoryOperations = (): React.ReactElement => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), OPERATIONAL_REFETCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  const userRoles = getAuthUser()?.roles;
  const canAccess = (path: string) => hasRoleAccess(userRoles, getAllowedRoles(path));
  const overviewQuery = useQuery<OverviewStats>({
    queryKey: queryKeys.factoryOperationsOverview,
    queryFn: getOverview,
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const eventsQuery = useQuery<{ items: EventInfo[]; total: number }>({
    queryKey: queryKeys.factoryOperationsEvents(1, 8),
    queryFn: () => getEventsPage(8, undefined, 24, 0),
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });
  const plansQuery = useQuery<SchedulingPlanV2[]>({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
    staleTime: QUERY_STALE_TIME_MS,
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
  });

  const currentTime = Math.max(now, Date.now());
  const overviewIsCurrent = !overviewQuery.isError && isFactoryDataCurrent(overviewQuery.dataUpdatedAt, currentTime);
  const kpis = useMemo(
    () => buildFactoryOperationsKpis(overviewQuery.data, overviewIsCurrent),
    [overviewQuery.data, overviewIsCurrent],
  );
  const attentionItems = useMemo(
    () => buildAttentionItems(eventsQuery.data?.items, plansQuery.data),
    [eventsQuery.data?.items, plansQuery.data],
  );
  const dataSources = [
    { label: '指标', query: overviewQuery },
    { label: '异常', query: eventsQuery },
    { label: '方案', query: plansQuery },
  ];
  const refreshAll = () => {
    void overviewQuery.refetch();
    void eventsQuery.refetch();
    void plansQuery.refetch();
  };
  const isRefreshing = overviewQuery.isFetching || eventsQuery.isFetching || plansQuery.isFetching;
  const hasDataError = overviewQuery.isError || eventsQuery.isError || plansQuery.isError;
  const attentionIsCurrent = [eventsQuery, plansQuery].every(
    (query) => query.data !== undefined && !query.isError && isFactoryDataCurrent(query.dataUpdatedAt, currentTime),
  );

  return (
    <div className="flex min-h-full flex-col gap-6 p-4 sm:p-6" data-testid="factory-operations">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Factory className="size-4" /> EWOH · 工厂运行台
          </div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">今天的工厂，先处理什么？</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            先核对异常来源与证据，再查看方案影响、审批和派工状态。方案预测不能替代现场执行反馈。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {isRefreshing ? '刷新中…' : '各项数据获取时间见下方'}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={refreshAll} disabled={isRefreshing}>
            <RefreshCw className="size-3" />刷新
          </Button>
        </div>
      </header>

      <section className="space-y-2 text-xs text-muted-foreground" aria-label="数据来源与新鲜度">
        <p>平台汇总未提供来源占比与采集时间，可能包含模拟、测试或历史数据；获取成功不代表现场实时或健康。</p>
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {dataSources.map(({ label, query }) => (
            <li key={label}>
              {label}：{query.isError ? '更新失败 · ' : query.isFetching ? '获取中 · ' : ''}
              {formatFreshness(query.dataUpdatedAt, currentTime)}
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="工厂平台汇总指标">
        {kpis.map((kpi) => (
          <div key={kpi.key} data-testid={`kpi-${kpi.key}`} className={`rounded-xl border p-4 ${toneClasses[kpi.tone]}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium opacity-80">{kpi.label}</span>
              {kpi.key === 'eventCritical' ? <AlertTriangle className="size-4" /> : <Activity className="size-4" />}
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums">{kpi.value}</p>
            <p className="mt-2 text-xs leading-5">{kpi.detail}</p>
          </div>
        ))}
      </section>

      {hasDataError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-risk-degraded-border bg-risk-degraded-soft p-4 text-sm text-risk-degraded-foreground" role="status">
          <span>部分平台数据更新失败，保留的快照可能已过时，不能据此判断当前没有异常。</span>
          <Button type="button" size="sm" variant="outline" onClick={refreshAll} disabled={isRefreshing}>重新获取</Button>
        </div>
      )}

      <div className="grid min-h-0 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <section className="rounded-xl border border-border bg-card shadow-sm" aria-labelledby="attention-title">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
            <div>
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-risk-degraded-foreground" />
                <h2 id="attention-title" className="font-semibold text-foreground">现在需要处理</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">异常按风险展示，方案优先展示待派工与待审批；各显示最多4项。</p>
            </div>
            <SectionLink to="/alerts">查看全部异常</SectionLink>
          </div>
          <p className="px-5 py-3 text-xs text-muted-foreground">
            异常仅查询近24小时最新8条记录（含已关闭事件）
            {eventsQuery.data ? `，已取得 ${eventsQuery.data.items.length} / ${eventsQuery.data.total} 条` : ''}。
            请到异常中心核对其他时段与分页；此处不能证明全厂没有异常。
          </p>
          <div className="divide-y divide-border">
            {eventsQuery.isLoading && <div className="p-5"><LoadingLine label="异常" /></div>}
            {eventsQuery.isError && <div className="p-5"><ErrorLine label="异常" onRetry={() => eventsQuery.refetch()} /></div>}
            {plansQuery.isLoading && <div className="p-5"><LoadingLine label="方案" /></div>}
            {plansQuery.isError && <div className="p-5"><ErrorLine label="方案" onRetry={() => plansQuery.refetch()} /></div>}
            {attentionItems.length === 0 && (
              <div className="p-5 text-sm text-muted-foreground" role="status">
                {attentionIsCurrent
                  ? '当前已加载记录中没有待处理异常或调度方案，请继续核对完整列表。'
                  : '异常或方案数据尚未完整更新，暂不能确认待处理事项。'}
              </div>
            )}
            {attentionItems.map((item) => (
              <Link key={item.id} to={item.href} className="flex items-start gap-3 p-5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border ${toneClasses[item.tone]}`}>
                  {item.kind === 'plan' ? <Clock3 className="size-4" /> : item.kind === 'system' ? <ClipboardList className="size-4" /> : <AlertTriangle className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {item.title}
                    <Badge variant="outline" className={toneClasses[item.tone]}>{item.kind === 'plan' ? '调度决策' : item.kind === 'system' ? '系统记录' : '现场异常'}</Badge>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{item.detail}</span>
                  <span className="mt-2 block text-xs font-medium text-primary">{item.actionLabel}</span>
                </span>
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </section>

        <div className="space-y-6">
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm" aria-labelledby="next-action-title">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h2 id="next-action-title" className="font-semibold text-foreground">下一步</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              查看异常证据后，进入排产调度选择触发条件；在具体方案中核对影响，再由授权人员审批和派工。
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              {canAccess('/scheduling') && <Button asChild><Link to="/scheduling">生成调度方案<ArrowRight className="size-4" /></Link></Button>}
              {canAccess('/simulation') && <Button asChild variant="outline"><Link to="/simulation">打开仿真推演<ArrowRight className="size-4" /></Link></Button>}
              {!canAccess('/scheduling') && <p className="text-xs text-muted-foreground">当前角色可核对异常与地图，调度审批和派工请联系授权调度人员。</p>}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-sm" aria-labelledby="trust-title">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-risk-normal-foreground" />
              <h2 id="trust-title" className="font-semibold text-foreground">执行前需要核对什么？</h2>
            </div>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-4 text-muted-foreground" /><span><strong className="font-medium text-foreground">先审后派工</strong><span className="block text-xs text-muted-foreground">影子评估不是执行授权，审批也不代表任务已完成。</span></span></div>
              <div className="flex items-start gap-3"><Users className="mt-0.5 size-4 text-muted-foreground" /><span><strong className="font-medium text-foreground">人员与负荷需核验</strong><span className="block text-xs text-muted-foreground">绑定人数不等于在岗人数，平均负荷不代表每个人的状态。</span></span></div>
              <div className="flex items-start gap-3"><WifiOff className="mt-0.5 size-4 text-muted-foreground" /><span><strong className="font-medium text-foreground">数据缺失会显式提示</strong><span className="block text-xs text-muted-foreground">请核对各项获取时间，并在地图查看采集来源与执行反馈。</span></span></div>
            </div>
          </section>
        </div>
      </div>

      <ExecutionFeedback />

      <section className="rounded-xl border border-border bg-muted/40 p-4" aria-label="运行台快捷入口">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-sm font-medium text-foreground">需要深入判断？</p><p className="mt-1 text-xs text-muted-foreground">方案卡保留方案编号；以下为模块入口，进入地图后需选择方案查看执行反馈。</p></div>
          <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link to="/command-map">打开现场地图</Link></Button>{canAccess('/approval-console') && <Button asChild size="sm" variant="outline"><Link to="/approval-console">查看待审批</Link></Button>}{canAccess('/decision-history') && <Button asChild size="sm" variant="outline"><Link to="/decision-history">复盘历史决策</Link></Button>}</div>
        </div>
      </section>
    </div>
  );
};

export default FactoryOperations;
