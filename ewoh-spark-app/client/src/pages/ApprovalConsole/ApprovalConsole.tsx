import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, ShieldCheck, XCircle, Bell, RotateCcw } from 'lucide-react';
import {
  getApprovalDetail,
  listAgentPendingApprovals,
  getNotificationMetrics,
  listNotifications,
  listCapabilityAuthorizations,
  listSchedulerPendingApprovals,
  markNotificationRead,
  resolveAgentApproval,
  retryNotification,
  stepApprovalAction,
  type ApprovalDetail,
} from '../../api/approvals';
import { getRuns } from '../../api/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import {
  agentApprovalActionable,
  buildApprovalRows,
  formatRemaining,
  notificationChannelLabel,
  notificationState,
  authorizationSummary,
  buildAuthorizationRows,
  buildNotificationGovernanceView,
  notificationResolutionText,
  notificationSummary,
} from './approvalConsoleLogic';
import { TRIGGER_LABELS } from '../Scheduling/planActions';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import ErrorState from '@client/src/components/ErrorState';
import { track } from '../../lib/telemetry';
import { toast } from 'sonner';
import { Textarea } from '@client/src/components/ui/textarea';
import { parseError } from '@client/src/lib/errorContract';

/**
 * 审批控制台（ADR-030 / NO-12f，§17 操作台"是否批准？"）。
 *
 * - 待批清单：Agent 命令审批（批准/驳回动作）+ 调度审批（展开详情按
 *   pending step 批准/驳回）；
 * - 通知中心：未读通知列表 + 标记已读；
 * - 过期审批显式禁用操作（§33：过期不静默可操作）。
 */
function formatRunTime(iso: string | null | undefined): string {
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

function RunBadge({ status }: { status: string }): React.ReactElement {
  if (status === 'succeeded') {
    return (
      <Badge variant="outline" className="border border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground">
        成功
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="outline" className="border border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground">
        失败
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground">
      {status}
    </Badge>
  );
}

const ApprovalConsole = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [agentRejectingId, setAgentRejectingId] = useState<string | null>(null);
  const [agentRejectReason, setAgentRejectReason] = useState('');

  // Approval caches must use the tenant-scoped approvals prefix. Bare keys can
  // hit the previous account's cache after an org switch (CLI-715 class bug).
  const agentQuery = useQuery({
    queryKey: [...queryKeys.approvals, 'agent'],
    queryFn: listAgentPendingApprovals,
    refetchInterval: 30000,
  });
  const schedulerQuery = useQuery({
    queryKey: [...queryKeys.approvals, 'scheduler'],
    queryFn: listSchedulerPendingApprovals,
    refetchInterval: 30000,
  });
  // NO-24a：执行边界授权（已授权 + 时效 + 消耗）——与待批清单互补
  const authorizationQuery = useQuery({
    queryKey: [...queryKeys.approvals, 'authorizations'],
    queryFn: listCapabilityAuthorizations,
    refetchInterval: 30000,
  });
  const notificationQuery = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => listNotifications(),
    refetchInterval: 30000,
  });
  /**
   * NO-46a：提醒治理（运行记忆）——处置率/时长/账龄/反复出现的提醒。
   * 只读聚合；样本不足时服务端返回 null，页面显示"证据不足"。
   */
  const governanceQuery = useQuery({
    queryKey: [...queryKeys.notifications, 'governance'],
    queryFn: () => getNotificationMetrics(30),
    refetchInterval: 60000,
  });
  const runsQuery = useQuery({
    queryKey: queryKeys.schedulerRuns({ pageSize: 20 }),
    queryFn: () => getRuns({ pageSize: 20 }),
    refetchInterval: 30000,
  });
  const detailQuery = useQuery({
    queryKey: [...queryKeys.approvals, 'detail', expanded],
    queryFn: () => getApprovalDetail(expanded!),
    enabled: expanded != null,
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
    void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
  };

  const resolveAgent = useMutation({
    mutationFn: ({
      approvalId,
      approved,
      reason,
    }: {
      approvalId: string;
      approved: boolean;
      reason?: string;
    }) => resolveAgentApproval(approvalId, approved, reason),
    onError: (err) => {
      toast.error('Agent 审批失败', { description: parseError(err).message });
    },
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
    onError: (err) => {
      toast.error('调度审批失败', { description: parseError(err).message });
    },
    onSuccess: invalidateAll,
  });
  const markRead = useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    // CLI-002：失败不再静默，toast 透传后端错误信息。
    onError: (err) => {
      toast.error('标记已读失败', {
        description: parseError(err).message,
      });
    },
  });
  const retryPush = useMutation({
    mutationFn: (notificationId: string) => retryNotification(notificationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
    // CLI-002：重试失败显式反馈（§33 失败不静默）。
    onError: (err) => {
      toast.error('推送重试失败', {
        description: parseError(err).message,
      });
    },
  });

  const rows = buildApprovalRows(agentQuery.data ?? [], schedulerQuery.data ?? []);
  /**
   * FE-1：待批清单是**两个**查询合并的结果，任一读失败（403/500）都会让 rows 退化为空，
   * 旧写法随即渲染"当前没有待批审批。"——把"没读到"说成"没有待批"。任一失败即视为不可用。
   */
  const approvalsErrored = agentQuery.isError || schedulerQuery.isError;
  const approvalsError = agentQuery.isError ? agentQuery.error : schedulerQuery.error;
  const authorizationRows = buildAuthorizationRows(authorizationQuery.data ?? []);
  const authorizationStats = authorizationSummary(authorizationRows);
  const notifications = notificationSummary(notificationQuery.data ?? []);
  const governance = buildNotificationGovernanceView(governanceQuery.data);
  const busy = resolveAgent.isPending || stepAction.isPending || markRead.isPending;
  // R-08：本地横幅状态改名 bannerErrorMessage，避免与 errorContract 导入的
  // errorMessage() 工具函数同名遮蔽（原同名导致 mutation onError 处 TDZ 不可调用）。
  const bannerErrorMessage = resolveAgent.error
    ? parseError(resolveAgent.error).message
    : stepAction.error
      ? parseError(stepAction.error).message
      : null;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <ShieldCheck className="h-7 w-7 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">审批控制台</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {/* FE-1：读失败时不给具体数字（0 会被读成"没有待批"），用 — 表示未知。 */}
            待批审批 {approvalsErrored ? '—' : rows.length} 项 · 未读通知{' '}
            {notificationQuery.isError ? '—' : notifications.unread} 条（审批闭环交互面，ADR-030）
            <br />
            执行边界授权：{authorizationQuery.isError ? '读取失败，无法判断授权状态' : authorizationStats.label}
          </p>
        </div>
      </header>

      {bannerErrorMessage && (
        <div className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked-foreground">
          {bannerErrorMessage}
        </div>
      )}

      {/* ── NO-24a：执行边界授权（有效/即将过期/已过期 + 用量）─────────
          已授权不是"批完就完"：它有时效（24 小时）、且逐台/逐个被消耗。
          过期授权必须**明确标注不可用**而不是消失——现场需要知道"授权失效了，要重新申请"。 */}
      <section data-testid="authorization-section">
        <h2 className="mb-3 text-lg font-semibold text-foreground">执行边界授权</h2>
        {authorizationQuery.isError && (
          <div className="rounded-lg border border-risk-blocked/30 bg-risk-blocked/10 p-3 text-sm text-risk-blocked-foreground">
            授权视图读取失败：{authorizationQuery.error instanceof Error ? authorizationQuery.error.message : '未知错误'}
          </div>
        )}
        {!authorizationQuery.isError && authorizationRows.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground" data-testid="authorization-empty">
            当前没有执行边界授权记录：任务能力放宽与设备能力恢复的审批（含时效与用量）都会显示在这里。
          </div>
        )}
        {authorizationRows.length > 0 && (
          <ul className="space-y-2" data-testid="authorization-list">
            {authorizationRows.map((auth) => (
              <li
                key={auth.approvalId}
                className="rounded-lg border border-border bg-card p-3"
                data-testid={`authorization-${auth.approvalId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      {auth.entityTypeLabel}：{auth.scope}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      审批号 <span className="font-mono">{auth.approvalId}</span>
                      {auth.approvedAt ? ` · 通过于 ${new Date(auth.approvedAt).toLocaleString('zh-CN')}` : ''}
                      {auth.expiresAt ? ` · 失效于 ${new Date(auth.expiresAt).toLocaleString('zh-CN')}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        auth.usableNow
                          ? 'rounded border border-risk-normal-border bg-risk-normal-soft px-2 py-0.5 text-xs text-risk-normal-foreground'
                          : 'rounded border border-risk-blocked-border bg-risk-blocked-soft px-2 py-0.5 text-xs text-risk-blocked-foreground'
                      }
                      data-testid={`authorization-state-${auth.approvalId}`}
                    >
                      {auth.stateLabel}
                      {auth.remainingLabel ? `（剩余 ${auth.remainingLabel}）` : ''}
                    </span>
                  </div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground" data-testid={`authorization-usage-${auth.approvalId}`}>
                  已消耗 {auth.consumedCount} 个对象：{auth.usageDetail}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 待批清单 ─────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">待批审批</h2>
        {approvalsErrored ? (
          <div data-testid="approvals-error">
            <ErrorState
              error={approvalsError}
              errorMessage="待批审批读取失败：无法获取待批清单。"
              onRetry={() => {
                void agentQuery.refetch();
                void schedulerQuery.refetch();
              }}
            />
          </div>
        ) : rows.length === 0 ? (
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
                            ? 'rounded bg-risk-blocked/10 px-2 py-1 text-xs text-risk-blocked-foreground'
                            : 'rounded bg-risk-degraded/10 px-2 py-1 text-xs text-risk-degraded-foreground'
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
                          onClick={() => {
                            setAgentRejectingId(null);
                            setAgentRejectReason('');
                            resolveAgent.mutate({ approvalId: row.approvalId, approved: true });
                          }}
                        >
                          批准
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !agentApprovalActionable(row.agent!)}
                          onClick={() => {
                            setAgentRejectingId(
                              agentRejectingId === row.approvalId ? null : row.approvalId,
                            );
                            setAgentRejectReason('');
                          }}
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
                    {/* OD-1/US-3：对象描述符提供深链，审批人可先看对象再决策，
                        不必再回侧边栏逐页找。老数据无描述符时不渲染该入口。 */}
                    {row.deepLink ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          track('approval_deeplink_click', {
                            approvalId: row.approvalId,
                            objectType: row.subject?.objectType ?? 'unknown',
                          });
                          navigate(row.deepLink as string);
                        }}
                      >
                        查看对象
                      </Button>
                    ) : null}
                  </div>
                </div>
                {agentRejectingId === row.approvalId && (
                  <div className="mt-3 w-full space-y-2 border-t pt-3">
                    <label
                      htmlFor={`agent-reject-reason-${row.approvalId}`}
                      className="block text-sm font-medium text-foreground"
                    >
                      驳回理由（必填，写入审计）
                    </label>
                    <Textarea
                      id={`agent-reject-reason-${row.approvalId}`}
                      value={agentRejectReason}
                      onChange={(event) => setAgentRejectReason(event.target.value)}
                      placeholder="说明为什么不能执行该 Agent 命令"
                      rows={3}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setAgentRejectingId(null);
                          setAgentRejectReason('');
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        variant="default"
                        disabled={busy || !agentRejectReason.trim()}
                        onClick={() =>
                          resolveAgent.mutate({
                            approvalId: row.approvalId,
                            approved: false,
                            reason: agentRejectReason,
                          })
                        }
                      >
                        提交驳回
                      </Button>
                    </div>
                  </div>
                )}
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
          {/* FE-1：读失败时这三个计数是伪造的 0（data undefined → 0），
              必须与页头一致显示 "—"——错误态正上方不能挂着假计数（2026-09-13 补口）。 */}
          <span className="text-xs font-normal text-muted-foreground">
            未读 {notificationQuery.isError ? '—' : notifications.unread} · 已读{' '}
            {notificationQuery.isError ? '—' : notifications.read} · 已处置{' '}
            {notificationQuery.isError ? '—' : notifications.resolved}
          </span>
        </h2>
        {/* FE-1：通知读失败时不能落回"没有未读通知。"——提醒是否叫到人是要据此判断的。 */}
        {notificationQuery.isError ? (
          <div data-testid="notifications-error">
            <ErrorState
              error={notificationQuery.error}
              errorMessage="通知读取失败：无法获取通知列表。"
              onRetry={() => {
                void notificationQuery.refetch();
              }}
            />
          </div>
        ) : notifications.pending.length === 0 ? (
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

        {/* NO-44a：已处置（随主事实收工/中止/更正关闭）——不是"已读"，
            必须显示谁在何时因哪次处置关闭，否则等于把"提醒消失了"当成"事情办完了"。 */}
        {notifications.resolvedList.length > 0 && (
          <div className="mt-4" data-testid="notification-resolved">
            <h3 className="text-sm font-medium text-muted-foreground">
              已处置 {notifications.resolvedList.length} 条（随主事实关闭，不需要再处理）
            </h3>
            <ul className="mt-2 space-y-1.5">
              {notifications.resolvedList.map((n) => (
                <li
                  key={n.notificationId}
                  className="rounded-lg border border-border bg-card p-3"
                  data-testid={`notification-resolved-${n.notificationId}`}
                >
                  <div className="truncate text-sm text-foreground">{n.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {notificationResolutionText(n) ?? '处置信息缺失（状态已关闭但没记录依据）'}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* NO-46a：提醒治理（运行记忆）——回答"处置得快不快、哪些提醒反复出现、
            有多少被放着没人管"。样本不足时明说"证据不足"，绝不显示 0%。 */}
        <div className="mt-4" data-testid="notification-governance">
          <h3 className="text-sm font-medium text-muted-foreground">提醒治理（运行记忆）</h3>
          {governanceQuery.isError ? (
            <p className="mt-1 text-xs text-risk-degraded-foreground" data-testid="notification-governance-error">
              提醒治理数据读取失败（
              {governanceQuery.error instanceof Error ? governanceQuery.error.message : '原因未知'}）
              ——这里不会显示成 0。
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="notification-governance-scope">
                {governance.scopeLabel}
              </p>
              <p className="mt-1 text-xs text-foreground" data-testid="notification-governance-totals">
                {governance.totalsLabel}
              </p>
              <p className="mt-1 text-xs text-foreground" data-testid="notification-governance-rate">
                {governance.dispositionRateLabel}
              </p>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="notification-governance-latency">
                {governance.latencyLabel}
              </p>
              {governance.agingRows.length > 0 && (
                <div className="mt-2" data-testid="notification-governance-aging">
                  <div className="text-xs font-medium text-muted-foreground">待处理账龄（有多少被放着没人管）</div>
                  <ul className="mt-1 space-y-0.5">
                    {governance.agingRows.map((bucket) => (
                      <li key={bucket.key} className="text-xs text-muted-foreground">
                        {bucket.label}：{bucket.count} 条
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {governance.kindRows.length > 0 && (
                <div className="mt-2" data-testid="notification-governance-kinds">
                  <div className="text-xs font-medium text-muted-foreground">按类型（哪类提醒最费人）</div>
                  <ul className="mt-1 space-y-0.5">
                    {governance.kindRows.map((row) => (
                      <li key={row.kind} className="text-xs text-muted-foreground">
                        {row.label}：{row.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {governance.topSourceRows.length > 0 && (
                <div className="mt-2" data-testid="notification-governance-top-sources">
                  <div className="text-xs font-medium text-muted-foreground">反复出现的对象（Top 5）</div>
                  <ul className="mt-1 space-y-0.5">
                    {governance.topSourceRows.map((row) => (
                      <li key={row.externalRef} className="text-xs text-muted-foreground">
                        {row.externalRef}（{row.kindLabel}）：{row.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {governance.notes.length > 0 && (
                <ul className="mt-2 space-y-0.5" data-testid="notification-governance-notes">
                  {governance.notes.map((note) => (
                    <li key={note} className="text-[11px] text-muted-foreground">
                      · {note}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

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
                          <span className="text-risk-blocked-foreground">投递失败{n.errorMessage ? `：${n.errorMessage}` : ''}</span>
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

      {/* ── 调度运行记录 ─────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
          <RotateCcw className="h-5 w-5" />
          调度运行记录
        </h2>
        {runsQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载运行记录…
          </div>
        ) : runsQuery.isError ? (
          /* FE-1：运行记录读失败时绝不落回"暂无运行记录。"（调度是否跑过不能被误报成没跑过）。 */
          <div data-testid="runs-error">
            <ErrorState
              error={runsQuery.error}
              errorMessage="调度运行记录读取失败（不代表没有运行记录）。"
              onRetry={() => {
                void runsQuery.refetch();
              }}
            />
          </div>
        ) : !runsQuery.data?.runs || runsQuery.data.runs.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            暂无运行记录。
          </div>
        ) : (
          <div className="space-y-2">
            {runsQuery.data.runs.map((run) => (
              <div
                key={run.runId}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-mono text-xs text-foreground">
                    {run.runId}
                  </p>
                  <RunBadge status={run.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {TRIGGER_LABELS[run.triggerType] ?? run.triggerType} ·{' '}
                  {formatRunTime(run.createdAt)} · 方案 {run.planIds.length} 个
                </p>
                {run.error && (
                  <p className="mt-1 text-xs text-risk-blocked-foreground">{run.error}</p>
                )}
              </div>
            ))}
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
    return <div className="mt-3 text-sm text-risk-blocked-foreground">审批详情加载失败。</div>;
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
