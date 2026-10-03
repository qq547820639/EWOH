import { useMemo } from 'react';
import { DISPLAY_TIME_OPTS_MONTH_DAY } from '../../lib/intl';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { JourneyRail } from '@client/src/components/app-shell/JourneyRail';
import { getAlert, transitionAlert, type AlertDetail } from '../../api/alerts';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import { Button } from '@client/src/components/ui/button';
import { errorDescription } from '@client/src/lib/errorContract';
import { getAuthUser } from '../../lib/auth';
import { resolveObjectRoute } from '../Scheduling/planActions';
import {
  alertJourney,
  availableAlertActions,
  severityBadge,
} from '../Alerts/alertActions';

/**
 * 告警对象工作台内容（J2 RK-1，设计规格补充 §2/§3）。
 *
 * 由 ObjectWorkbench 按 objectType='alert' 分派（分支位于其全部 hooks 之后，
 * 不影响 React hooks 顺序；J1 的 scheduling_plan 路径零改动）。
 *
 * 设计裁决落地点：
 * - 概览字段清单：title/severity/status/createdAt/deviceId，内部字段不进 UI；
 * - 证据 tab：evidenceJson 结构不稳定，首轮折叠键值对、不做翻译字典；
 * - 关联对象：单类型（设备），不渲染空分组；
 * - 流程带：alertJourney 由 status 派生（JourneyRail 复用）；
 * - 动作区：availableAlertActions（角色感知，与 /alerts 列表同一事实源）。
 */

const ALERT_STATUS_LABEL: Record<string, string> = {
  open: '待确认',
  acknowledged: '已确认',
  processing: '处置中',
  closed: '已关闭',
  reopened: '已重开',
};

type TabKey = 'overview' | 'related' | 'history' | 'evidence';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'related', label: '关联对象' },
  { key: 'history', label: '状态历史' },
  { key: 'evidence', label: '证据' },
];

const isTabKey = (v: string | null): v is TabKey => TABS.some((t) => t.key === v);

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY);
}

function SeverityBadge({ severity }: { severity: string | null }): React.ReactElement {
  const cfg = severityBadge(severity);
  const Icon = cfg.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${cfg.className}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {cfg.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string | null }): React.ReactElement {
  const label = ALERT_STATUS_LABEL[status ?? 'open'] ?? (status ?? '未知');
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

export function AlertWorkbenchContent({
  objectId,
  activeTab,
  onTabChange,
}: {
  objectId: string;
  activeTab: TabKey;
  onTabChange: (key: TabKey) => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userRoles = getAuthUser()?.roles ?? null;

  const detailQuery = useQuery<AlertDetail>({
    queryKey: [...queryKeys.alerts, 'detail', objectId],
    queryFn: () => getAlert(objectId),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const detail = detailQuery.data ?? null;
  const journey = useMemo(
    () => alertJourney(detail?.status ?? null, objectId),
    [detail?.status, objectId],
  );
  const actions = useMemo(
    () => availableAlertActions(detail?.status ?? null, userRoles),
    [detail?.status, userRoles],
  );

  const transitionMutation = useMutation({
    mutationFn: ({ eventId, action }: { eventId: string; action: string }) =>
      transitionAlert(eventId, action),
    onSuccess: () => {
      toast.success('告警状态已更新');
      queryClient.invalidateQueries({ queryKey: queryKeys.alerts });
    },
    onError: (err) => {
      toast.error('状态更新失败', { description: errorDescription(err) });
    },
  });

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-5" role="status" aria-live="polite">
        <div className="h-5 w-2/3 animate-pulse rounded bg-muted-foreground/10" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted-foreground/10" />
        <div className="h-3 w-1/4 animate-pulse rounded bg-muted-foreground/10" />
        <p className="text-xs text-muted-foreground">正在加载告警详情…</p>
      </div>
    );
  }
  if (detailQuery.isError || !detail) {
    return (
      <div className="rounded-lg border border-risk-blocked-border bg-risk-blocked-soft p-5">
        <p className="text-sm text-risk-blocked-foreground">
          {errorDescription(detailQuery.error) ?? '告警不存在或已被清理'}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3 min-h-11 sm:min-h-9"
          onClick={() => void detailQuery.refetch()}
        >
          重试
        </Button>
      </div>
    );
  }

  const deviceRoute = detail.deviceId ? resolveObjectRoute('device', detail.deviceId) : undefined;
  const evidenceEntries = Object.entries(detail.evidence ?? {});

  return (
    <div className="space-y-6">
      {/* J2 流程带：由状态派生，永远与真实状态一致 */}
      <JourneyRail
        steps={journey}
        onNavigate={(route) => navigate(route)}
        ariaLabel="告警处置进度"
      />

      {/* 头部：人类可读标题（告警自带 title，无需对象描述符） */}
      <header className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-lg font-semibold text-foreground">
              {detail.title ?? detail.eventId}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {detail.eventId}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              产生于 {formatTime(detail.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={detail.severity} />
            <StatusBadge status={detail.status} />
          </div>
        </div>

        {/* 动作区：角色感知派生（与 /alerts 同一事实源）；无可用动作时明确说明 */}
        <div className="mt-4 flex flex-wrap gap-2">
          {actions.length === 0 ? (
            <p className="text-xs text-muted-foreground">当前角色无可执行操作</p>
          ) : (
            actions.map((action) => (
              <Button
                key={action.action}
                size="sm"
                variant={action.action === 'acknowledge' ? 'default' : 'outline'}
                disabled={transitionMutation.isPending}
                className="min-h-11 sm:min-h-9"
                onClick={() =>
                  transitionMutation.mutate({ eventId: detail.eventId, action: action.action })
                }
              >
                {transitionMutation.isPending && (
                  <Loader2 className="size-3 animate-spin" />
                )}
                {action.label}
              </Button>
            ))
          )}
        </div>
      </header>

      {/* Tabs（URL 同步 ?tab=） */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onTabChange(tab.key)}
            aria-current={activeTab === tab.key ? 'page' : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
              activeTab === tab.key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-w-0">
        {activeTab === 'overview' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-medium text-foreground">基本信息</h2>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">严重度</dt>
                  <dd><SeverityBadge severity={detail.severity} /></dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">状态</dt>
                  <dd><StatusBadge status={detail.status} /></dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">产生时间</dt>
                  <dd className="tabular-nums text-foreground">{formatTime(detail.createdAt)}</dd>
                </div>
              </dl>
            </section>
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-medium text-foreground">处置</h2>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">当前环节</dt>
                  <dd className="text-foreground">
                    {journey.find((s) => s.state === 'current')?.label ?? '已完成'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">可用操作</dt>
                  <dd className="text-foreground">
                    {actions.length > 0 ? actions.map((a) => a.label).join(' / ') : '无（角色受限）'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        )}

        {activeTab === 'related' && (
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium text-foreground">
              关联设备
              <span className="ml-2 text-xs font-normal text-muted-foreground">1 项</span>
            </h2>
            {detail.deviceId ? (
              <ul className="flex flex-wrap gap-2">
                <li>
                  {deviceRoute ? (
                    <button
                      type="button"
                      onClick={() => navigate(deviceRoute)}
                      className="inline-flex min-h-11 items-center rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground transition-colors hover:bg-muted sm:min-h-0"
                    >
                      {detail.deviceId}
                    </button>
                  ) : (
                    <span className="inline-flex items-center rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground">
                      {detail.deviceId}
                    </span>
                  )}
                </li>
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">本告警未关联设备。</p>
            )}
          </section>
        )}

        {activeTab === 'history' && (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            状态历史暂无独立留痕数据源。当前状态：
            {ALERT_STATUS_LABEL[detail.status ?? 'open'] ?? detail.status ?? '未知'}。
          </div>
        )}

        {activeTab === 'evidence' && (
          <section className="rounded-lg border border-border bg-card p-4">
            {evidenceEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">本告警无证据快照。</p>
            ) : (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  证据快照（{evidenceEntries.length} 项）
                </summary>
                {/* evidenceJson 结构不保证稳定：键值对原样呈现，不做翻译字典 */}
                <dl className="mt-3 space-y-1.5 text-xs">
                  {evidenceEntries.map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
                      <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
                      <dd className="break-all text-right text-foreground">
                        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
