import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  approvePlan,
  createRun,
  dispatchPlanV2,
  getActivePlans,
  getRuns,
  rejectPlanV2,
  replan,
} from '../../api/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import { SchedulerRealtimeProvider } from '../../scheduler/SchedulerRealtimeProvider';
import { getCurrentOperator, getAuthUser } from '../../lib/auth';
import { LazyPlanList } from '../../components/LazyPlanList';
import { PlanMetricGrid } from '@client/src/components/business-ui/MetricCard';
import { deriveNarrationStatus } from '../../lib/narration';
import { track } from '../../lib/telemetry';
import { PLAN_STATUS_BADGE, TRIGGER_LABELS, planActions } from './planActions';
import type { PlanStatus, SchedulingPlanV2 } from '@shared/api.interface';
import { errorDescription } from '@client/src/lib/errorContract';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import QueryState from '../../components/QueryState';

type StatusFilter = 'all' | 'pending' | 'approved';

const STATUS_FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: '全部', value: 'all' },
  { label: '待审批', value: 'pending' },
  { label: '已审批', value: 'approved' },
];

// TRIGGER_LABELS 已收敛至 ./planActions（与对象工作台共用，避免术语漂移）。

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function isPendingStatus(status: PlanStatus): boolean {
  return status === 'draft' || status === 'shadow';
}

/**
 * 方案状态徽章（横切 X-3）：状态色一律取自语义 Token `risk-*`，
 * 替换原先的 Tailwind 默认色族（emerald/cyan/amber），从而响应
 * 暗色 / 高对比 / 反色三套主题——此前这些区域对三套主题全部无响应。
 */
function statusBadge(status: PlanStatus): React.ReactElement {
  const cfg = PLAN_STATUS_BADGE[status] ?? {
    label: status,
    className: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <Badge variant="outline" className={`border ${cfg.className}`}>
      {cfg.label}
    </Badge>
  );
}

/**
 * 运行记录状态徽章（横切 X-3）：同样收敛到语义 Token，使暗色 / 高对比 / 反色
 * 三套主题对该区域生效（此前 emerald / blue 硬编码对三套主题全部无响应）。
 */
function runBadge(status: string): React.ReactElement {
  if (status === 'succeeded') {
    return (
      <Badge
        variant="outline"
        className="border border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground"
      >
        成功
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge
        variant="outline"
        className="border border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground"
      >
        失败
      </Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge
        variant="outline"
        className="border border-risk-offline-border bg-risk-offline-soft text-risk-offline-foreground"
      >
        运行中
      </Badge>
    );
  }
  return <Badge variant="outline">排队中</Badge>;
}

function isPlanStaleError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  const status = e.response?.status;
  const dataMsg = (e.response?.data as { message?: string } | undefined)?.message;
  const msg = dataMsg ?? e.message ?? '';
  return status === 409 && msg.includes('PLAN_STALE');
}

/** 单个方案卡片（LazyPlanList 的 renderItem 渲染体；ADR-082 导出供渲染 smoke）。 */
export interface PlanCardProps {
  row: SchedulingPlanV2;
  actionFor: string | null;
  actionMode: 'approve' | 'reject';
  actionReason: string;
  approvePending: boolean;
  rejectPending: boolean;
  dispatchPending: boolean;
  replanPending: boolean;
  onStartAction: (planId: string, mode: 'approve' | 'reject') => void;
  onCancelAction: () => void;
  onActionReasonChange: (value: string) => void;
  onHandleAction: (row: SchedulingPlanV2) => void;
  onDispatch: (row: SchedulingPlanV2) => void;
  onReplan: (row: SchedulingPlanV2) => void;
  /** OD-5：导航型动作（查看执行态势 / 决策历史）的路由回调；缺省时该类动作点击无副作用。 */
  onNavigate?: (route: string) => void;
  /** OD-6：AI 解读状态派生基准时间，由调用方注入以保证可测试；缺省取渲染时刻。 */
  nowMs?: number;
}

/** ADR-082：导出供渲染 smoke 测试（纯展示，无内部状态）。 */
export function PlanCard({
  row,
  actionFor,
  actionMode,
  actionReason,
  approvePending,
  rejectPending,
  dispatchPending,
  replanPending,
  onStartAction,
  onCancelAction,
  onActionReasonChange,
  onHandleAction,
  onDispatch,
  onReplan,
  onNavigate,
  nowMs,
}: PlanCardProps): React.ReactElement {
  const narrationStatus = deriveNarrationStatus(row, nowMs ?? Date.now());
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-foreground">
            {row.planName ?? row.planId}
          </p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {row.planId}
          </p>
        </div>
        {statusBadge(row.status)}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        v{row.version} · {TRIGGER_LABELS[row.trigger.type] ?? row.trigger.type} ·{' '}
        {formatTime(row.createdAt)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        延期 {row.metrics.lateMinutes.toFixed(0)}min · 移动{' '}
        {row.metrics.walkingMeters.toFixed(0)}m · 等待{' '}
        {row.metrics.stationWaitMinutes.toFixed(0)}min · 负荷{' '}
        {(row.metrics.maxWorkload * 100).toFixed(0)}%
      </p>
      {/* OD-6：AI 调度说明层。此前未生成时整块不渲染，用户看到的是永久空白，
          无法区分「生成中 / 生成失败 / 未启用」；现按派生状态给出明确呈现。 */}
      {narrationStatus === 'done' ? (
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-primary">
            <Sparkles className="size-3" />
            {row.narrationSource === 'llm' ? 'AI 方案解读' : '规则摘要'}
          </p>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
            {row.aiNarration}
          </p>
        </div>
      ) : narrationStatus === 'pending' ? (
        <div
          className="mt-3 rounded-lg border border-border bg-muted p-3"
          role="status"
          aria-live="polite"
        >
          <p className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            AI 方案解读生成中
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            通常需要 30–90 秒，完成后自动填充。
          </p>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-border bg-muted p-3">
          <p className="text-[10px] text-muted-foreground">
            本方案暂无 AI 解读（未启用或生成未成功），指标仍可正常评估。
          </p>
        </div>
      )}

      {/* OD-7：原始 metrics 不再以 JSON 直出给最终用户，改为结构化指标卡。
          折叠呈现以免在列表视图中撑高卡片。 */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          指标详情
        </summary>
        <div className="mt-2">
          <PlanMetricGrid metrics={row.metrics} />
        </div>
      </details>

      {actionFor === row.planId ? (
        <div className="mt-3 space-y-2">
          <Input
            value={actionReason}
            onChange={(e) => onActionReasonChange(e.target.value)}
            placeholder={
              actionMode === 'reject' ? '驳回理由（必填）' : '审批理由（可选）'
            }
            className="h-8 text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={
                approvePending ||
                rejectPending ||
                (actionMode === 'reject' && !actionReason.trim())
              }
              onClick={() => onHandleAction(row)}
            >
              {approvePending || rejectPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : actionMode === 'reject' ? (
                <X className="size-3" />
              ) : (
                <CheckCircle2 className="size-3" />
              )}
              {approvePending || rejectPending
                ? actionMode === 'reject'
                  ? '驳回中...'
                  : '审批中...'
                : actionMode === 'reject'
                  ? '确认驳回'
                  : '确认审批'}
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelAction}>
              <X className="size-3" />
              取消
            </Button>
          </div>
        </div>
      ) : (
        // OD-5：动作区由 planActions 单一事实源驱动（与对象工作台共用同一份定义）。
        // 终态不再只剩一行静态文本——每个终态至少 1 个后继入口，闭合"派工黑洞"。
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* B5 审批独立性：生成人不可自批——给明确说明而非隐藏原因 */}
          {row.createdBy && row.createdBy === getAuthUser()?.userId && (
            <span className="mr-1 inline-flex items-center rounded-md border border-risk-degraded-border bg-risk-degraded-soft px-2 py-0.5 text-xs text-risk-degraded-foreground">
              本方案由你生成，需他人审批
            </span>
          )}
          {planActions(row.status, row.planId, {
            createdBy: row.createdBy,
            currentUserId: getAuthUser()?.userId ?? null,
          }).map((action) => {
            const pending =
              (action.kind === 'approve' && approvePending) ||
              (action.kind === 'reject' && rejectPending) ||
              (action.kind === 'dispatch' && dispatchPending) ||
              (action.kind === 'replan' && replanPending);
            const icon =
              action.kind === 'approve' ? (
                <CheckCircle2 className="size-3" />
              ) : action.kind === 'reject' ? (
                <X className="size-3" />
              ) : action.kind === 'dispatch' ? (
                <Send className="size-3" />
              ) : action.kind === 'replan' ? (
                <RotateCcw className="size-3" />
              ) : null;
            return (
              <Button
                key={action.kind}
                size="sm"
                variant={
                  action.variant === 'primary'
                    ? 'default'
                    : action.variant === 'danger'
                      ? 'destructive'
                      : action.variant === 'secondary'
                        ? 'outline'
                        : 'ghost'
                }
                className={action.variant === 'primary' ? 'flex-1' : undefined}
                disabled={pending}
                onClick={() => {
                  // 埋点：终态出口点击率（PRD §8 驱动指标，目标 ≥ 25%）。
                  // 仅统计终态（已下发/已驳回/已完成/已替代）的后继入口。
                  if (action.route) {
                    track('terminal_action_click', {
                      action: action.kind,
                      status: row.status,
                    });
                    onNavigate?.(action.route);
                    return;
                  }
                  switch (action.kind) {
                    case 'approve':
                      onStartAction(row.planId, 'approve');
                      break;
                    case 'reject':
                      onStartAction(row.planId, 'reject');
                      break;
                    case 'dispatch':
                      onDispatch(row);
                      break;
                    case 'replan':
                      onReplan(row);
                      break;
                    default:
                      break;
                  }
                }}
              >
                {pending ? <Loader2 className="size-3 animate-spin" /> : icon}
                {action.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const Scheduling = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // 注意：SSE 实时订阅由本页根部的 SchedulerRealtimeProvider（单例）拥有。

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [actionFor, setActionFor] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<'approve' | 'reject'>('approve');
  const [actionReason, setActionReason] = useState('');

  // 活跃方案列表（V2）：来自 React Query 缓存，由 createRun 结果 + SSE 事件流维护。
  const plansQuery = useQuery<SchedulingPlanV2[]>({
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
  });

  // 运行历史 + 活跃方案（服务端权威数据）。首次加载用其 plans 播种活跃列表缓存。
  const runsQuery = useQuery({
    queryKey: queryKeys.schedulerRuns({ pageSize: 20 }),
    queryFn: () => getRuns({ pageSize: 20 }),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  useEffect(() => {
    const serverPlans = runsQuery.data?.plans;
    if (!serverPlans || serverPlans.length === 0) return;
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) => {
      if (prev && prev.length > 0) return prev;
      return serverPlans;
    });
  }, [runsQuery.data, queryClient]);

  const rows = plansQuery.data ?? [];
  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    if (statusFilter === 'approved') {
      return rows.filter((row) =>
        ['approved', 'dispatched', 'executing', 'completed'].includes(row.status),
      );
    }
    return rows.filter((row) => isPendingStatus(row.status));
  }, [rows, statusFilter]);

  const recentRuns = runsQuery.data?.runs ?? [];

  const appendPlans = (newPlans: SchedulingPlanV2[]) => {
    if (!newPlans || newPlans.length === 0) return;
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) => {
      const merged = [...(prev ?? []), ...newPlans];
      const seen = new Set<string>();
      return merged.filter((p) => (seen.has(p.planId) ? false : (seen.add(p.planId), true)));
    });
  };

  const refreshPlan = (plan: SchedulingPlanV2) => {
    queryClient.setQueryData<SchedulingPlanV2[]>(queryKeys.schedulerActivePlans, (prev) =>
      (prev ?? []).map((p) => (p.planId === plan.planId ? plan : p)),
    );
    queryClient.invalidateQueries({ queryKey: queryKeys.schedulerRuns() });
  };

  const generateMutation = useMutation({
    mutationFn: () => createRun({ trigger: 'MANUAL', operator: getCurrentOperator() }),
    onSuccess: (data) => {
      if (data.debounced || !data.run) {
        toast.info('调度已排队，请稍后刷新');
        return;
      }
      if (data.plans.length > 0) {
        appendPlans(data.plans);
        toast.success(`已生成 ${data.plans.length} 个调度方案`);
      } else {
        toast.info('本次未生成新方案');
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerRuns() });
    },
    onError: (err) => {
      toast.error('方案生成失败', {
        description: errorDescription(err),
      });
    },
  });

  const approveMutation = useMutation({
    mutationFn: ({ plan, reason }: { plan: SchedulingPlanV2; reason: string }) =>
      approvePlan(plan.planId, {
        version: plan.version,
        snapshotVersion: plan.snapshotVersion,
        operator: getCurrentOperator(),
        reason,
      }),
    onSuccess: (plan) => {
      toast.success('方案已审批通过');
      setActionFor(null);
      setActionReason('');
      refreshPlan(plan);
    },
    onError: (err) => {
      if (isPlanStaleError(err)) {
        toast.error('该方案生成后现场状态已发生变化，请重新计算');
      } else if (
        err instanceof Error &&
        err.message.includes('SELF_APPROVAL_FORBIDDEN')
      ) {
        // B5 审批独立性：后端 hard guard（前端已预判过滤，此处为深链/并发兜底）。
        toast.error('本方案由你生成，不能由本人审批，请交由其他有权限的同事审批');
      } else {
        toast.error('方案审批失败', {
          description: errorDescription(err),
        });
      }
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ plan, reason }: { plan: SchedulingPlanV2; reason: string }) =>
      rejectPlanV2(plan.planId, { operator: getCurrentOperator(), reason }),
    onSuccess: (plan) => {
      toast.success('方案已驳回');
      setActionFor(null);
      setActionReason('');
      refreshPlan(plan);
    },
    onError: (err) => {
      // R2-CP2-004：透传后端错误详情（与 CLI-028 修复口径一致）。
      toast.error('方案驳回失败', {
        description: errorDescription(err),
      });
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) => dispatchPlanV2(plan.planId, getCurrentOperator()),
    onSuccess: (plan) => {
      toast.success('方案已下发执行');
      // T12-B（2026-08-28 审计）：dispatch 成功但 Execution 建档 3 次重试耗尽时，
      // 响应携带 executionSync 降级警告（此前前端 0 消费 = 静默数据缺口）。
      const executionSync = (
        plan as SchedulingPlanV2 & { executionSync?: { ok: boolean; error: string } }
      ).executionSync;
      if (executionSync && executionSync.ok === false) {
        toast.warning('方案已下发，但执行跟踪建档失败', {
          description: executionSync.error,
        });
      }
      refreshPlan(plan);
    },
    onError: (err) => {
      toast.error('下发失败', {
        description: errorDescription(err),
      });
    },
  });

  const replanMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      replan(plan.planId, {
        lockedConstraints: [],
        operator: getCurrentOperator(),
        reason: '手动重新排程',
      }),
    onSuccess: (plan) => {
      toast.success('已重新排程生成新方案');
      appendPlans([plan]);
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerRuns() });
    },
    onError: (err) => {
      toast.error('重新排程失败', {
        description: errorDescription(err),
      });
    },
  });

  const startAction = (planId: string, mode: 'approve' | 'reject') => {
    setActionFor(planId);
    setActionMode(mode);
    setActionReason('');
  };

  const cancelAction = () => {
    setActionFor(null);
    setActionReason('');
  };

  const handleAction = (plan: SchedulingPlanV2) => {
    if (actionMode === 'reject') {
      if (!actionReason.trim()) {
        toast.error('请填写驳回理由');
        return;
      }
      rejectMutation.mutate({ plan, reason: actionReason });
    } else {
      approveMutation.mutate({ plan, reason: actionReason.trim() || '调度中心审批' });
    }
  };

  // CLI-222：聚合全部在途 mutation 错误（原仅取首个，并发失败时丢失其余错误）。
  const mutationErrors = [
    generateMutation.error,
    approveMutation.error,
    rejectMutation.error,
    dispatchMutation.error,
    replanMutation.error,
  ]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);
  const mutationError =
    mutationErrors.length > 0 ? mutationErrors.join('；') : null;

  return (
    <SchedulerRealtimeProvider>
      <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">生产调度中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            方案生成、审批、下发与执行跟踪。
          </p>
        </div>
        <Button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          className="inline-flex items-center gap-2"
        >
          {generateMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {generateMutation.isPending ? '生成中...' : '生成方案'}
        </Button>
      </header>

      <div className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={statusFilter === filter.value ? 'default' : 'outline'}
            onClick={() => setStatusFilter(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {mutationError && (
        <div className="flex items-start gap-2 rounded-lg border border-risk-blocked-border bg-risk-blocked-soft p-4 text-sm text-risk-blocked-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {mutationError}
        </div>
      )}

      <QueryState
        isLoading={plansQuery.isLoading}
        isFetching={plansQuery.isFetching}
        isError={plansQuery.isError}
        isStale={plansQuery.isStale}
        isEmpty={!plansQuery.data || filteredRows.length === 0}
        onRefresh={() => {
          plansQuery.refetch();
          runsQuery.refetch();
        }}
        errorMessage={
          plansQuery.error instanceof Error ? plansQuery.error.message : '数据加载失败'
        }
        loadingMessage="正在加载调度方案"
        emptyMessage="暂无调度方案，点击「生成方案」创建。"
        updatedAt={plansQuery.dataUpdatedAt}
      >
        <LazyPlanList<SchedulingPlanV2>
          items={filteredRows}
          itemKey={(row) => row.planId}
          renderItem={(row) => (
            <PlanCard
              row={row}
              actionFor={actionFor}
              actionMode={actionMode}
              actionReason={actionReason}
              approvePending={approveMutation.isPending}
              rejectPending={rejectMutation.isPending}
              dispatchPending={dispatchMutation.isPending}
              replanPending={replanMutation.isPending}
              onStartAction={startAction}
              onCancelAction={cancelAction}
              onActionReasonChange={setActionReason}
              onHandleAction={handleAction}
              onDispatch={(r) => dispatchMutation.mutate(r)}
              onReplan={(r) => replanMutation.mutate(r)}
              onNavigate={(route) => navigate(route)}
            />
          )}
          className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3"
          itemClassName="min-w-0"
        />
      </QueryState>

      <div className="mt-6">
        <h2 className="text-lg font-semibold text-foreground">调度运行记录</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          最近调度运行（以服务端为准）。
        </p>
        <div className="mt-3 space-y-2">
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无运行记录。</p>
          ) : (
            recentRuns.map((run) => (
              <div
                key={run.runId}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-mono text-xs text-foreground">
                    {run.runId}
                  </p>
                  {runBadge(run.status)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {TRIGGER_LABELS[run.triggerType] ?? run.triggerType} ·{' '}
                  {formatTime(run.createdAt)} · 方案 {run.planIds.length} 个
                </p>
                {run.error && (
                  <p className="mt-1 text-xs text-risk-blocked-foreground">{run.error}</p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
    </SchedulerRealtimeProvider>
  );
};

export default Scheduling;