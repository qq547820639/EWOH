import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, ShieldCheck, XCircle, Bell } from 'lucide-react';
import {
  getApprovalDetail,
  listAgentPendingApprovals,
  listNotifications,
  listSchedulerPendingApprovals,
  markNotificationRead,
  resolveAgentApproval,
  retryNotification,
  stepApprovalAction,
  type ApprovalDetail,
} from '../../api/approvals';
import {
  agentApprovalActionable,
  buildApprovalRows,
  formatRemaining,
  notificationChannelLabel,
  notificationState,
  notificationSummary,
} from './approvalConsoleLogic';
import { Button } from '@client/src/components/ui/button';
import { toast } from 'sonner';

/**
 * 审批控制台（ADR-030 / NO-12f，§17 操作台"是否批准？"）。
 *
 * - 待批清单：Agent 命令审批（批准/驳回动作）+ 调度审批（展开详情按
 *   pending step 批准/驳回）；
 * - 通知中心：未读通知列表 + 标记已读；
 * - 过期审批显式禁用操作（§33：过期不静默可操作）。
 */
const ApprovalConsole = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const agentQuery = useQuery({
    queryKey: ['approvals', 'agent'],
    queryFn: listAgentPendingApprovals,
    refetchInterval: 30000,
  });
  const schedulerQuery = useQuery({
    queryKey: ['approvals', 'scheduler'],
    queryFn: listSchedulerPendingApprovals,
    refetchInterval: 30000,
  });
  const notificationQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () => listNotifications(),
    refetchInterval: 30000,
  });
  const detailQuery = useQuery({
    queryKey: ['approvals', 'detail', expanded],
    queryFn: () => getApprovalDetail(expanded!),
    enabled: expanded != null,
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const resolveAgent = useMutation({
    mutationFn: ({ approvalId, approved }: { approvalId: string; approved: boolean }) =>
      resolveAgentApproval(approvalId, approved),
    onSuccess: invalidateAll,
  });
  const stepAction = useMutation({
    mutationFn: ({
      approvalId,
      stepId,
      action,
    }: {
      approvalId: string;
      stepId: string;
      action: 'approve' | 'reject';
    }) => stepApprovalAction(approvalId, stepId, action),
    onSuccess: invalidateAll,
  });
  const markRead = useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    // CLI-002：失败不再静默，toast 透传后端错误信息。
    onError: (err) => {
      toast.error('标记已读失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });
  const retryPush = useMutation({
    mutationFn: (notificationId: string) => retryNotification(notificationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    // CLI-002：重试失败显式反馈（§33 失败不静默）。
    onError: (err) => {
      toast.error('推送重试失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const rows = buildApprovalRows(agentQuery.data ?? [], schedulerQuery.data ?? []);
  const notifications = notificationSummary(notificationQuery.data ?? []);
  const busy = resolveAgent.isPending || stepAction.isPending || markRead.isPending;
  const errorMessage =
    resolveAgent.error instanceof Error
      ? resolveAgent.error.message
      : stepAction.error instanceof Error
        ? stepAction.error.message
        : null;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="h-7 w-7 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">审批控制台</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            待批审批 {rows.length} 项 · 未读通知 {notifications.unread} 条（审批闭环交互面，ADR-030）
          </p>
        </div>
      </header>

      {errorMessage && (
        <div className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked">
          {errorMessage}
        </div>
      )}

      {/* ── 待批清单 ─────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">待批审批</h2>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            当前没有待批审批。
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.key} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-foreground">{row.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{row.detail}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {row.kind === 'agent' && (
                      <span
                        className={
                          row.expired
                            ? 'rounded bg-risk-blocked/10 px-2 py-1 text-xs text-risk-blocked'
                            : 'rounded bg-risk-degraded/10 px-2 py-1 text-xs text-risk-degraded'
                        }
                      >
                        {row.expired ? '已过期（不可操作）' : `剩余 ${formatRemaining(row.remainingMs, row.expired)}`}
                      </span>
                    )}
                    {row.kind === 'agent' && (
                      <>
                        <Button
                          size="sm"
                          variant="default"
                          disabled={busy || !agentApprovalActionable(row.agent!)}
                          onClick={() =>
                            resolveAgent.mutate({ approvalId: row.approvalId, approved: true })
                          }
                        >
                          批准
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !agentApprovalActionable(row.agent!)}
                          onClick={() =>
                            resolveAgent.mutate({ approvalId: row.approvalId, approved: false })
                          }
                        >
                          驳回
                        </Button>
                      </>
                    )}
                    {row.kind === 'scheduler' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setExpanded(expanded === row.approvalId ? null : row.approvalId)
                        }
                      >
                        {expanded === row.approvalId ? '收起' : '查看详情'}
                      </Button>
                    )}
                  </div>
                </div>
                {row.kind === 'scheduler' && expanded === row.approvalId && (
                  <SchedulerDetail
                    detail={detailQuery.data ?? null}
                    loading={detailQuery.isPending}
                    onAction={(stepId, action) =>
                      stepAction.mutate({ approvalId: row.approvalId, stepId, action })
                    }
                    busy={busy}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 通知中心 ─────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
          <Bell className="h-5 w-5" />
          通知中心
          <span className="text-xs font-normal text-muted-foreground">
            未读 {notifications.unread} · 已读 {notifications.read}
          </span>
        </h2>
        {notifications.pending.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            没有未读通知。
          </div>
        ) : (
          <ul className="space-y-2">
            {notifications.pending.map((n) => (
              <li
                key={n.notificationId}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {n.title}
                  </div>
                  {n.body && (
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{n.body}</div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={markRead.isPending}
                  onClick={() => markRead.mutate(n.notificationId)}
                >
                  标记已读
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* R-58/R-62 / ADR-037/ADR-041：推送渠道状态（飞书/邮件投递 + 失败显式 + 人工重试） */}
        {notifications.push.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-muted-foreground">推送状态</h3>
            <ul className="mt-2 space-y-1.5">
              {notifications.push.map((n) => {
                const state = notificationState(n);
                return (
                  <li
                    key={n.notificationId}
                    className="flex items-center justify-between gap-2 rounded border border-border bg-card px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="truncate text-xs font-medium text-foreground">{n.title}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {notificationChannelLabel(n.channel)} ·{' '}
                        {state === 'push-pending' && '待投递'}
                        {state === 'push-sent' && '已投递'}
                        {state === 'push-failed' && (
                          <span className="text-risk-blocked">投递失败{n.errorMessage ? `：${n.errorMessage}` : ''}</span>
                        )}
                        {state === 'unknown' && `状态 ${n.status}`}
                      </span>
                    </div>
                    {state === 'push-failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retryPush.isPending}
                        onClick={() => retryPush.mutate(n.notificationId)}
                      >
                        重试
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
};

function SchedulerDetail({
  detail,
  loading,
  onAction,
  busy,
}: {
  detail: ApprovalDetail | null;
  loading: boolean;
  onAction: (stepId: string, action: 'approve' | 'reject') => void;
  busy: boolean;
}): React.ReactElement {
  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载审批详情…
      </div>
    );
  }
  if (!detail) {
    return <div className="mt-3 text-sm text-risk-blocked">审批详情加载失败。</div>;
  }
  const pendingSteps = (detail.steps ?? []).filter((s) => s.status === 'pending');
  if (pendingSteps.length === 0) {
    return (
      <div className="mt-3 text-sm text-muted-foreground">
        该审批实例已无 pending 步骤（状态 {detail.status ?? 'unknown'}）。
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      {pendingSteps.map((step) => (
        <div
          key={step.id}
          className="flex items-center justify-between gap-2 rounded border border-border bg-muted p-2"
        >
          <span className="text-sm text-muted-foreground">步骤角色：{step.role}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" disabled={busy} onClick={() => onAction(step.id, 'approve')}>
              <CheckCircle2 className="mr-1 h-4 w-4" />
              批准
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(step.id, 'reject')}>
              <XCircle className="mr-1 h-4 w-4" />
              驳回
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default ApprovalConsole;
