import { useEffect, useMemo, useState } from 'react';
import { DISPLAY_TIME_OPTS_MONTH_DAY } from '../../lib/intl';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  approvePlan,
  dispatchPlanV2,
  getPlan,
  rejectPlanV2,
  replan,
} from '../../api/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import { getCurrentOperator } from '../../lib/auth';
import { deriveNarrationStatus } from '../../lib/narration';
import { track } from '../../lib/telemetry';
import { errorDescription } from '@client/src/lib/errorContract';
import { Button } from '@client/src/components/ui/button';
import { PlanMetricGrid } from '@client/src/components/business-ui/MetricCard';
import QueryState from '../../components/QueryState';
import { AlertWorkbenchContent } from './AlertWorkbenchContent';
import type { PlanStatus, SchedulingPlanV2 } from '@shared/api.interface';
import { JourneyRail } from '@client/src/components/app-shell/JourneyRail';
import { getAuthUser } from '../../lib/auth';
import {
  PLAN_STATUS_BADGE,
  TRIGGER_LABELS,
  WRITE_ACTIONS,
  planActions,
  planJourney,
  resolveObjectRoute,
  type PlanActionKind,
} from '../Scheduling/planActions';

/**
 * 对象工作台（Object Workbench，OD-2 / OD-3）。
 *
 * 以「对象」而非「页面」为导航主干：同一对象的内容视图、动作区、状态历史、证据
 * 收敛在同一屏，顶部 Journey 式的面包屑保留返回路径。
 *
 * 交付范围裁决：
 *   - **首批仅接 `scheduling_plan`**（PRD Q-1 建议，防工作量低估）；其余类型给出明确
 *     的不支持空态，不静默白屏。
 *   - 头部元信息采用**替代方案**：`SchedulingPlanV2` 无「责任人」「数据来源」字段
 *     （见评估报告 §8.3），改用信息价值更高的 `solverStatus` / `fallbackReason` /
 *     `violations`，不新增后端依赖。
 *   - 动作区复用 `planActions` 单一事实源，与排产调度页**共用同一套 API 函数**，
 *     不产生第二套状态跃迁实现。
 */

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'related', label: '关联对象' },
  { key: 'history', label: '状态历史' },
  { key: 'evidence', label: '证据' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const isTabKey = (v: string | null): v is TabKey =>
  TABS.some((t) => t.key === v);

const SUPPORTED_TYPES = new Set(['scheduling_plan', 'alert']);

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY);
}

function StatusBadge({ status }: { status: PlanStatus }): React.ReactElement {
  const cfg = PLAN_STATUS_BADGE[status] ?? {
    label: status,
    className: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${cfg.className}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {cfg.label}
    </span>
  );
}

/** AI 方案解读：补齐 pending / unavailable 态，消除"未生成即空白"的断点。 */
function NarrationPanel({
  plan,
  nowMs,
}: {
  plan: SchedulingPlanV2;
  nowMs: number;
}): React.ReactElement {
  const status = deriveNarrationStatus(plan, nowMs);

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
          <Sparkles className="size-3" />
          {plan.narrationSource === 'llm' ? 'AI 方案解读' : '规则摘要'}
        </p>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
          {plan.aiNarration}
        </p>
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div
        className="rounded-lg border border-border bg-muted p-4"
        role="status"
        aria-live="polite"
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          AI 方案解读生成中
        </p>
        <div className="space-y-2" aria-hidden="true">
          <div className="h-3 w-full animate-pulse rounded bg-muted-foreground/10" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted-foreground/10" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          通常需要 30–90 秒，完成后会自动填充。
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <p className="text-xs text-muted-foreground">
        本方案暂无 AI 解读（未启用或生成未成功）。指标与证据仍可正常查看。
      </p>
    </div>
  );
}

const ObjectWorkbench = (): React.ReactElement => {
  const { objectType = '', objectId = '' } = useParams<{
    objectType: string;
    objectId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingKind, setPendingKind] = useState<PlanActionKind | null>(null);

  const tabParam = searchParams.get('tab');
  const activeTab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';

  const supported = SUPPORTED_TYPES.has(objectType);

  // 埋点：对象工作台曝光（PRD §8 驱动指标）。依赖里不含 plan，避免数据刷新重复计数。
  useEffect(() => {
    if (!supported || !objectId) return;
    track('object_workbench_view', { objectType, objectId });
  }, [supported, objectId, objectType]);

  const planQuery = useQuery<SchedulingPlanV2>({
    queryKey: queryKeys.schedulerPlan(objectId),
    queryFn: () => getPlan(objectId),
    enabled: supported && objectId.length > 0,
  });

  const setTab = (key: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlan(objectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedulerActivePlans });
  };

  const approveMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      approvePlan(plan.planId, {
        version: plan.version,
        snapshotVersion: plan.snapshotVersion,
        operator: getCurrentOperator(),
        reason: '对象工作台审批',
      }),
    onSuccess: () => {
      toast.success('方案已审批通过');
      refresh();
    },
    onError: (err) => toast.error('审批失败', { description: errorDescription(err) }),
  });

  const rejectMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      rejectPlanV2(plan.planId, {
        operator: getCurrentOperator(),
        reason: '对象工作台驳回',
      }),
    onSuccess: () => {
      toast.success('方案已驳回');
      refresh();
    },
    onError: (err) => toast.error('驳回失败', { description: errorDescription(err) }),
  });

  const dispatchMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      dispatchPlanV2(plan.planId, getCurrentOperator()),
    onSuccess: (plan) => {
      toast.success('方案已下发执行');
      const executionSync = (
        plan as SchedulingPlanV2 & { executionSync?: { ok: boolean; error: string } }
      ).executionSync;
      if (executionSync && executionSync.ok === false) {
        toast.warning('方案已下发，但执行跟踪建档失败', {
          description: executionSync.error,
        });
      }
      refresh();
    },
    onError: (err) => toast.error('下发失败', { description: errorDescription(err) }),
  });

  const replanMutation = useMutation({
    mutationFn: (plan: SchedulingPlanV2) =>
      replan(plan.planId, {
        lockedConstraints: [],
        operator: getCurrentOperator(),
        reason: '对象工作台重新排程',
      }),
    onSuccess: () => {
      toast.success('已重新排程生成新方案');
      refresh();
    },
    onError: (err) =>
      toast.error('重新排程失败', { description: errorDescription(err) }),
  });

  const plan = planQuery.data ?? null;

  const runAction = (kind: PlanActionKind) => {
    if (!plan) return;
    switch (kind) {
      case 'approve':
        setPendingKind('approve');
        approveMutation.mutate(plan, { onSettled: () => setPendingKind(null) });
        break;
      case 'reject':
        setPendingKind('reject');
        rejectMutation.mutate(plan, { onSettled: () => setPendingKind(null) });
        break;
      case 'dispatch':
        setPendingKind('dispatch');
        dispatchMutation.mutate(plan, { onSettled: () => setPendingKind(null) });
        break;
      case 'replan':
        setPendingKind('replan');
        replanMutation.mutate(plan, { onSettled: () => setPendingKind(null) });
        break;
      default:
        break;
    }
  };

  // B5 审批独立性：生成人不得自批（动作过滤 + 明确说明，避免点击后 403）。
  const isSelfApproval = Boolean(
    plan?.createdBy && plan.createdBy === getAuthUser()?.userId,
  );
  const actions = useMemo(
    () =>
      plan
        ? planActions(plan.status, plan.planId, {
            createdBy: plan.createdBy,
            currentUserId: getAuthUser()?.userId ?? null,
          })
        : [],
    [plan],
  );

  const busy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    dispatchMutation.isPending ||
    replanMutation.isPending;

  // 关联对象按资源类型聚合（数据来自真实 assignments，不做任何补齐推测）。
  const related = useMemo(() => {
    if (!plan) return { persons: [], devices: [], stations: [] as string[] };
    const personSet = new Set<string>();
    const deviceSet = new Set<string>();
    const stationSet = new Set<string>();
    for (const a of plan.assignments ?? []) {
      if (a.personId) personSet.add(a.personId);
      if (a.deviceId) deviceSet.add(a.deviceId);
      if (a.stationId) stationSet.add(a.stationId);
    }
    return {
      persons: [...personSet],
      devices: [...deviceSet],
      stations: [...stationSet],
    };
  }, [plan]);

  const nowMs = Date.now();
  const narrationStatus = plan ? deriveNarrationStatus(plan, nowMs) : 'unavailable';
  // OD-8：流程环节由方案状态派生，不引入额外持久状态，故不存在与真实状态脱节的风险。
  const journeySteps = useMemo(
    () => (plan ? planJourney(plan.status, narrationStatus, plan.planId) : []),
    [plan, narrationStatus],
  );

  // J2 RK-1：告警类型分派（J2 设计规格补充）。必须在全部 hooks 之后——
  // /o/:objectType/:objectId 是同一路由模板，参数切换时组件实例复用，hooks 顺序不可变；
  // planQuery 的 enabled 已排除 alert，不会发无效请求。
  if (objectType === 'alert') {
    return (
      <div className="space-y-6 p-4 sm:p-6">
        <AlertWorkbenchContent objectId={objectId} activeTab={activeTab} onTabChange={setTab} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <nav aria-label="返回">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="size-3.5" />
          返回
        </Button>
      </nav>

      {/* OD-8 Journey Rail：常驻顶部，用户随时知道"当前第几步、下一步去哪"。 */}
      {supported && plan && journeySteps.length > 0 ? (
        <JourneyRail
          steps={journeySteps}
          onNavigate={(route) => navigate(route)}
          ariaLabel="排产流程进度"
        />
      ) : null}

      {!supported ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-medium text-foreground">暂不支持的对象类型</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            对象工作台首批仅接入 <code className="font-mono">scheduling_plan</code>
            （PRD Q-1 范围裁决，防工作量低估）。
          </p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {objectType}
          </p>
        </div>
      ) : (
        <QueryState
          isLoading={planQuery.isLoading}
          isFetching={planQuery.isFetching}
          isError={planQuery.isError}
          isStale={planQuery.isStale}
          isEmpty={!plan}
          onRefresh={() => void planQuery.refetch()}
          errorMessage={
            planQuery.error instanceof Error ? planQuery.error.message : '方案加载失败'
          }
          loadingMessage="正在加载方案"
          emptyMessage="未找到该方案"
          updatedAt={planQuery.dataUpdatedAt}
        >
          {plan ? (
            <>
              <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h1 className="truncate text-2xl font-medium text-foreground">
                      {plan.planName ?? plan.planId}
                    </h1>
                    <StatusBadge status={plan.status} />
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {plan.planId} · v{plan.version}
                  </p>
                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <div className="flex gap-1.5">
                      <dt>生成于</dt>
                      <dd className="tabular-nums text-foreground">
                        {formatTime(plan.createdAt)}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>触发</dt>
                      <dd className="text-foreground">
                        {TRIGGER_LABELS[plan.trigger.type] ?? plan.trigger.type}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>求解</dt>
                      <dd className="text-foreground">
                        {plan.solverStatus ?? '—'}
                        {plan.fallbackReason ? `（${plan.fallbackReason}）` : ''}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>约束违反</dt>
                      <dd
                        className={
                          (plan.violations?.length ?? 0) > 0
                            ? 'text-risk-blocked-foreground'
                            : 'text-risk-normal-foreground'
                        }
                      >
                        {(plan.violations?.length ?? 0) > 0
                          ? `${plan.violations.length} 项`
                          : '无'}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* B5 审批独立性：生成人不可自批——给明确说明而非隐藏原因 */}
                  {isSelfApproval && (
                    <span className="inline-flex items-center rounded-md border border-risk-degraded-border bg-risk-degraded-soft px-2 py-0.5 text-xs text-risk-degraded-foreground">
                      本方案由你生成，需他人审批
                    </span>
                  )}
                  {actions.map((action) => (
                    <Button
                      key={action.kind}
                      size="sm"
                      // OD-10：移动端触控目标 44px（工业手套场景，横切 X-4），桌面回落 36px。
                      className="min-h-11 sm:min-h-9"
                      variant={
                        action.variant === 'primary'
                          ? 'default'
                          : action.variant === 'danger'
                            ? 'destructive'
                            : action.variant === 'secondary'
                              ? 'outline'
                              : 'ghost'
                      }
                      disabled={busy}
                      onClick={() => {
                        // 埋点：终态出口点击率（PRD §8 驱动指标，目标 ≥ 25%）。
                        track('terminal_action_click', {
                          action: action.kind,
                          status: plan?.status ?? 'unknown',
                        });
                        if (action.route) {
                          navigate(action.route);
                          return;
                        }
                        runAction(action.kind);
                      }}
                    >
                      {busy && pendingKind === action.kind ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : null}
                      {action.label}
                    </Button>
                  ))}
                  {actions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">当前状态无可用动作</p>
                  ) : null}
                </div>
              </header>

              <div
                className="flex gap-1 overflow-x-auto border-b border-border"
                role="tablist"
                aria-label="对象视图"
              >
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.key}
                    className={`min-h-10 shrink-0 border-b-2 px-3 text-[13px] transition-colors ${
                      activeTab === tab.key
                        ? 'border-primary font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => setTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div role="tabpanel">
                {activeTab === 'overview' ? (
                  <div className="space-y-6">
                    <PlanMetricGrid metrics={plan.metrics} />
                    <NarrationPanel plan={plan} nowMs={nowMs} />
                  </div>
                ) : null}

                {activeTab === 'related' ? (
                  <div className="space-y-4">
                    {[
                      { label: '人员', type: 'person', items: related.persons },
                      { label: '外骨骼设备', type: 'device', items: related.devices },
                      { label: '工位', type: 'station', items: related.stations },
                    ].map((group) => (
                      <section key={group.label}>
                        <h2 className="mb-2 text-sm font-medium text-foreground">
                          {group.label}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {group.items.length} 个
                          </span>
                        </h2>
                        {group.items.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            本方案未分配该类型资源。
                          </p>
                        ) : (
                          <ul className="flex flex-wrap gap-2">
                            {group.items.slice(0, 24).map((id) => {
                              // OD-9：沿用既有页面能力下钻，不新建页面；
                              // 无目标页（如工位）时渲染纯文本，不产生死链。
                              const route = resolveObjectRoute(group.type, id);
                              const chipClass =
                                'inline-flex min-h-11 items-center rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground sm:min-h-0';
                              return (
                                <li key={id}>
                                  {route ? (
                                    <button
                                      type="button"
                                      onClick={() => navigate(route)}
                                      className={`${chipClass} transition-colors hover:bg-muted`}
                                    >
                                      {id}
                                    </button>
                                  ) : (
                                    <span className={chipClass}>{id}</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    ))}
                  </div>
                ) : null}

                {activeTab === 'history' ? (
                  <ol className="ml-2 list-none border-l-2 border-border pl-4">
                    <li className="relative pb-4 text-[13px]">
                      <span
                        className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
                        aria-hidden="true"
                      />
                      当前状态：
                      {PLAN_STATUS_BADGE[plan.status]?.label ?? plan.status}
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {formatTime(plan.createdAt)}
                      </span>
                    </li>
                    <li className="relative pb-4 text-[13px] text-muted-foreground">
                      <span
                        className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-border ring-2 ring-background"
                        aria-hidden="true"
                      />
                      方案生成（v{plan.version}）
                      <span className="ml-2 font-mono text-[11px]">
                        {formatTime(plan.createdAt)}
                      </span>
                    </li>
                  </ol>
                ) : null}

                {activeTab === 'evidence' ? (
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">快照版本</dt>
                    <dd className="break-all font-mono text-xs">{plan.snapshotVersion}</dd>
                    <dt className="text-muted-foreground">策略版本</dt>
                    <dd className="tabular-nums">{plan.policyVersion}</dd>
                    <dt className="text-muted-foreground">求解器</dt>
                    <dd className="break-all font-mono text-xs">{plan.solverVersion}</dd>
                    <dt className="text-muted-foreground">求解耗时</dt>
                    <dd className="tabular-nums">
                      {plan.solveDurationMs != null ? `${plan.solveDurationMs} ms` : '—'}
                    </dd>
                    <dt className="text-muted-foreground">目标函数值</dt>
                    <dd className="tabular-nums">
                      {plan.objective != null ? plan.objective.toFixed(4) : '—'}
                    </dd>
                    <dt className="text-muted-foreground">约束违反</dt>
                    <dd>{(plan.violations?.length ?? 0) === 0 ? '无' : `${plan.violations.length} 项`}</dd>
                  </dl>
                ) : null}
              </div>
            </>
          ) : null}
        </QueryState>
      )}
    </div>
  );
};

export default ObjectWorkbench;
