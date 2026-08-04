import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GitPullRequest,
  GitMerge,
  GitFork,
  GitBranch,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  ScanLine,
  Waypoints,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkGitSync, getWorkGraph, applyWorkGitSync } from '../../api/work';
import { getCurrentOperator } from '../../lib/auth';
import { StatusBadge, WriteConfirmDialog } from './shared';
import {
  buildApprovalPacket,
  buildMappingStatus,
  buildProviderData,
  canExecute,
  createIdempotencyKey,
  linkLabel,
  type GitMappingRow,
  type WriteOperation,
} from '../../lib/gitSync';

const MAPPING_LABEL: Record<string, { text: string; tone: string }> = {
  bidirectional: { text: '双向已关联', tone: 'emerald' },
  issue_only: { text: '仅 Issue', tone: 'blue' },
  pr_only: { text: '仅 PR', tone: 'amber' },
  unlinked: { text: '未关联', tone: 'slate' },
};

const CI_LABEL: Record<string, { text: string; icon: typeof Clock }> = {
  success: { text: '成功', icon: CircleCheck },
  failed: { text: '失败', icon: CircleX },
  pending: { text: '进行中', icon: Clock },
  unknown: { text: '未知', icon: Clock },
};

const GitSyncPanel = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; retryable: boolean } | null>(null);

  const gitSyncQuery = useQuery({
    queryKey: queryKeys.workGitSync,
    queryFn: getWorkGitSync,
    staleTime: QUERY_STALE_TIME_MS,
    // 轮询增量刷新（UX-010.8）：离线文件化模式下读取本地 plan 快照。
    refetchInterval: 30_000,
  });

  const graphQuery = useQuery({
    queryKey: queryKeys.workGraph,
    queryFn: getWorkGraph,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const plan = gitSyncQuery.data;

  const mapRows = useMemo<GitMappingRow[]>(
    () =>
      (plan?.items ?? []).map((entry) => ({
        workItemId: entry.workItemId,
        title: entry.title,
        type: entry.type,
        owner: entry.owner,
        status: entry.status,
        issueNumber: entry.issueNumber,
        prNumber: entry.prNumber,
        branch: entry.branch,
        commitSha: entry.commitSha,
        state: entry.state,
        missing: entry.missing,
      })),
    [plan],
  );

  const providerData = useMemo(
    () =>
      buildProviderData({
        rows: mapRows,
        ciChecks: [],
        conflicts: [],
        timelineSources: {
          evidence: (graphQuery.data?.evidence ?? []).map((e) => ({
            id: e.evidenceId,
            workItemId: e.workItemId,
            kind: e.kind,
            result: e.result,
            testTime: e.testTime,
            status: e.status,
          })),
          gates: (graphQuery.data?.gates ?? []).map((g) => ({
            gateId: g.gateId,
            title: g.title,
            calculatedStatus: g.calculatedStatus,
            decidedAt: g.decidedAt,
          })),
        },
        timelineExtra: plan
          ? [
              {
                id: 'sync:plan',
                kind: 'sync',
                at: plan.generatedAt,
                summary: `Git 同步计划生成（${plan.repository || '本地仓库'} · ${plan.branch}）`,
                status: plan.status,
              },
            ]
          : [],
      }),
    [mapRows, graphQuery.data, plan],
  );

  // 增量同步说明见下方「增量同步」区块（UX-010.8）。
  const applyMutation = useMutation({
    mutationFn: async (body: { idempotencyKey: string; approved: boolean; reason?: string; actor?: string }) =>
      applyWorkGitSync(body),
    onSuccess: () => {
      toast.success('Git 同步计划已应用');
      setFailure(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.workGitSync });
    },
    onError: (error: unknown) => {
      const reason = error instanceof Error ? error.message : '同步失败';
      setFailure({ reason, retryable: /timeout|network|超时|网络/i.test(reason) });
      toast.error('同步失败');
    },
  });

  const handleApply = () => {
    setFailure(null);
    setApprovalOpen(true);
  };

  const handleConfirmApply = (reason: string) => {
    setApprovalOpen(false);
    const operator = getCurrentOperator();
    const operation: WriteOperation = 'create_issue';
    const idempotencyKey = createIdempotencyKey(operation, plan?.branch ?? 'main', plan?.headSha ?? '');
    const packet = buildApprovalPacket({
      operation,
      workItemId: 'plan',
      reason,
      actor: operator,
      rollbackPoint: `${plan?.headSha ?? 'HEAD'}@{0}`,
    });
    // 高风险写操作（创建/合并/关闭 PR）必须经审批；未批准不得执行。
    if (!canExecute(operation, packet)) {
      setFailure({ reason: '该写操作未经审批，已拒绝执行', retryable: false });
      return;
    }
    applyMutation.mutate({ idempotencyKey, approved: true, reason, actor: operator });
  };

  const ci = providerData.ci;
  const CiIcon = CI_LABEL[ci.status].icon;

  return (
    <QueryState
      isLoading={gitSyncQuery.isLoading}
      isFetching={gitSyncQuery.isFetching}
      isError={gitSyncQuery.isError}
      isStale={gitSyncQuery.isStale}
      isEmpty={!gitSyncQuery.data}
      onRefresh={() => gitSyncQuery.refetch()}
      errorMessage={gitSyncQuery.error instanceof Error ? gitSyncQuery.error.message : 'Git 同步加载失败'}
      loadingMessage="正在读取 Git 同步状态"
      updatedAt={gitSyncQuery.dataUpdatedAt}
    >
      <div className="space-y-4">
        {gd(providerData.providerConnected)}

        {/* 头部统计 */}
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
            <GitPullRequest className="h-4 w-4 text-slate-600" />
            <h2 className="font-semibold text-[hsl(220_14%_14%)]">GitHub Issue/PR 同步</h2>
            <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
              {providerData.mappingSummary.tracked} 已关联 /{' '}
              {providerData.mappingSummary.missing} 待同步
            </span>
            <button
              type="button"
              onClick={() => gitSyncQuery.refetch()}
              disabled={gitSyncQuery.isFetching}
              className="inline-flex items-center gap-1 rounded-md border border-[hsl(220_14%_89%)] bg-white px-2 py-1 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)] disabled:opacity-50"
              aria-label="轮询刷新 Git 同步状态"
            >
              {gitSyncQuery.isFetching ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              刷新
            </button>
          </div>

          {/* 映射表 */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                <tr>
                  <th className="px-5 py-3 font-medium">任务</th>
                  <th className="px-5 py-3 font-medium">Issue</th>
                  <th className="px-5 py-3 font-medium">PR</th>
                  <th className="px-5 py-3 font-medium">分支</th>
                  <th className="px-5 py-3 font-medium">Commit</th>
                  <th className="px-5 py-3 font-medium">映射状态</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                {providerData.mapping.map((entry) => {
                  const mapping = buildMappingStatus(entry);
                  const label = MAPPING_LABEL[mapping];
                  return (
                    <tr key={entry.workItemId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {entry.workItemId} · {entry.title}
                        </div>
                        <div className="text-xs text-[hsl(218_10%_42%)]">
                          {entry.type} · {entry.owner} · {entry.status}
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">{linkLabel(entry.issueNumber) ?? '—'}</td>
                      <td className="px-5 py-3 font-mono text-xs">{linkLabel(entry.prNumber) ?? '—'}</td>
                      <td className="px-5 py-3 font-mono text-xs">{entry.branch ?? '—'}</td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {entry.commitSha ? entry.commitSha.slice(0, 8) : '—'}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${toneClass(label.tone)}`}
                        >
                          {label.text}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={entry.state} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Dry Run 变更预览 */}
        <DryRunSection providerConnected={providerData.providerConnected} preview={providerData.dryRun} />

        {/* 冲突检测 */}
        <ConflictSection providerConnected={providerData.providerConnected} conflicts={providerData.conflicts} />

        {/* CI 状态回写 */}
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
            <GitMerge className="h-4 w-4 text-slate-600" />
            <h3 className="font-semibold text-[hsl(220_14%_14%)]">CI 状态回写</h3>
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-[hsl(218_10%_42%)]">
              <CiIcon className={`size-3.5 ${ciClass(ci.status)}`} />
              {CI_LABEL[ci.status].text} · {ci.total} 项检查
            </span>
          </div>
          {providerData.providerConnected ? (
            <p className="px-5 py-4 text-sm text-[hsl(218_10%_42%)]">
              关联 PR/提交的 CI 检查数量：成功 {ci.success} / 失败 {ci.failed} / 进行中 {ci.pending}。
            </p>
          ) : (
            <Placeholder text="CI 状态回写需接入真实 GitHub 连接器/凭据后读取，当前为离线文件化模式，不伪造真实 CI 状态。" />
          )}
        </section>

        {/* 审批后执行 */}
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
            <GitFork className="h-4 w-4 text-slate-600" />
            <h3 className="font-semibold text-[hsl(220_14%_14%)]">审批后执行</h3>
            <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
              高风险写操作（创建/合并/关闭 PR）须经审批
            </span>
            <button
              type="button"
              onClick={handleApply}
              disabled={applyMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {applyMutation.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <GitBranch className="size-3" />
              )}
              应用同步计划
            </button>
          </div>
          {failure && (
            <div className="flex items-center gap-2 border-t border-[hsl(220_14%_89%)] px-5 py-3 text-sm" role="alert">
              <CircleX className="size-4 shrink-0 text-red-500" />
              <span className="text-[hsl(220_14%_14%)]">{failure.reason}</span>
              {failure.retryable && (
                <button
                  type="button"
                  onClick={handleApply}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-[hsl(220_14%_89%)] bg-white px-2 py-1 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
                >
                  <RotateCcw className="size-3" />
                  重试
                </button>
              )}
            </div>
          )}
          <p className="px-5 py-4 text-xs text-[hsl(218_10%_42%)]">
            幂等键：{plan ? createIdempotencyKey('create_issue', plan.branch ?? 'main', plan.headSha ?? '') : '—'}
            （同一操作+目标+ref 生成相同键，避免重复提交）。
          </p>
        </section>

        {/* 统一时间线 */}
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
            <Waypoints className="h-4 w-4 text-slate-600" />
            <h3 className="font-semibold text-[hsl(220_14%_14%)]">统一时间线</h3>
            <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
              Agent / PR / 测试 / Evidence / Gate / CI
            </span>
          </div>
          {providerData.timeline.length === 0 ? (
            <Placeholder text="暂无时间线事件。离线模式下仅展示 Git 同步计划事件；Agent/PR/测试/证据/门禁事件随工作图与真实连接器接入后合并展示。" />
          ) : (
            <ol className="divide-y divide-[hsl(220_14%_89%)] px-5 py-2">
              {providerData.timeline.map((event) => (
                <li key={event.id} className="flex items-start gap-3 py-3 text-sm">
                  <span className={`mt-1 size-2 shrink-0 rounded-full ${kindDot(event.kind)}`} />
                  <div className="min-w-0">
                    <p className="text-[hsl(220_14%_14%)]">{event.summary}</p>
                    <p className="mt-0.5 text-xs text-[hsl(218_10%_42%)]">
                      {event.kind} · {new Date(event.at).toLocaleString('zh-CN', { hour12: false })}
                      {event.workItemId ? ` · ${event.workItemId}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* 增量同步提示 */}
        <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
            <ScanLine className="h-4 w-4 text-slate-600" />
            <h3 className="font-semibold text-[hsl(220_14%_14%)]">增量同步</h3>
          </div>
          <p className="px-5 py-4 text-xs text-[hsl(218_10%_42%)]">
            面板每 30 秒轮询刷新（UX-010.8）。当前为离线文件化模式，未接入真实 Webhook；
            如需推送式增量同步，可在接入真实 GitHub 连接器后启用事件订阅。
          </p>
        </section>
      </div>

      <WriteConfirmDialog
        open={approvalOpen}
        title="应用 Git 同步计划"
        description="将待同步的 WorkItem 映射为 GitHub Issue（创建 Issue 为低风险操作）。"
        actionLabel="确认应用"
        rollbackPoint={`${plan?.headSha ?? 'HEAD'}@{0}`}
        onCancel={() => setApprovalOpen(false)}
        onConfirm={handleConfirmApply}
      />
    </QueryState>
  );
};

/* ---------------- 子组件 ---------------- */

const gd = (connected: boolean) =>
  connected ? null : (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
      当前处于「离线文件化」模式：Git 历史/仓库文件为权威事实源。Dry Run、冲突、CI 等真实数据待接入真实 GitHub 连接器/凭据后注入。
    </div>
  );

const DryRunSection = ({
  providerConnected,
  preview,
}: {
  providerConnected: boolean;
  preview: { totalFiles: number; totalAdded: number; totalDeleted: number; totalLines: number };
}): React.ReactElement => (
  <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
    <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
      <GitBranch className="h-4 w-4 text-slate-600" />
      <h3 className="font-semibold text-[hsl(220_14%_14%)]">Dry Run 变更预览</h3>
      {providerConnected && (
        <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
          {preview.totalFiles} 文件 · +{preview.totalAdded} / -{preview.totalDeleted} · 共 {preview.totalLines} 行
        </span>
      )}
    </div>
    {providerConnected ? (
      preview.totalFiles > 0 ? (
        <p className="px-5 py-4 text-sm text-[hsl(218_10%_42%)]">变更预览已就绪。</p>
      ) : (
        <Placeholder text="本次计划无待推送/合并的文件变更。" />
      )
    ) : (
      <Placeholder text="Dry Run 变更预览（文件、行数、新增/删除）需接入真实 GitHub 连接器后基于本地未提交变更与目标分支差异生成。" />
    )}
  </section>
);

const ConflictSection = ({
  providerConnected,
  conflicts,
}: {
  providerConnected: boolean;
  conflicts: Array<{ workItemId: string; field: string; local: unknown; server: unknown }>;
}): React.ReactElement => (
  <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
    <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
      <GitMerge className="h-4 w-4 text-slate-600" />
      <h3 className="font-semibold text-[hsl(220_14%_14%)]">冲突检测</h3>
      {providerConnected && conflicts.length > 0 && (
        <span className="ml-auto text-xs font-medium text-red-600">{conflicts.length} 处冲突</span>
      )}
    </div>
    {providerConnected && conflicts.length > 0 ? (
      <ul className="divide-y divide-[hsl(220_14%_89%)] px-5 py-2">
        {conflicts.map((c, index) => (
          <li key={index} className="py-3 text-sm">
            <p className="font-medium text-[hsl(220_14%_14%)]">
              {c.workItemId} · {c.field}
            </p>
            <p className="mt-1 font-mono text-xs text-[hsl(218_10%_42%)]">
              本地值：{fmt(c.local)} | 服务端值：{fmt(c.server)}
            </p>
          </li>
        ))}
      </ul>
    ) : providerConnected ? (
      <Placeholder text="未检测到本地与服务端（目标分支）的冲突。" />
    ) : (
      <Placeholder text="冲突检测需对比本地状态与服务端（目标分支）状态，接入真实 GitHub 连接器后展示「本地值 / 服务端值 / 差异」。" />
    )}
  </section>
);

const Placeholder = ({ text }: { text: string }): React.ReactElement => (
  <p className="px-5 py-4 text-xs text-[hsl(218_10%_42%)]">{text}</p>
);

/* ---------------- 工具 ---------------- */

const toneClass = (tone: string): string => {
  const map: Record<string, string> = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    blue: 'border-blue-200 bg-blue-50 text-blue-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
  };
  return map[tone] ?? map.slate;
};

const ciClass = (status: string): string => {
  switch (status) {
    case 'success':
      return 'text-emerald-600';
    case 'failed':
      return 'text-red-600';
    case 'pending':
      return 'text-amber-600';
    default:
      return 'text-slate-500';
  }
};

const kindDot = (kind: string): string => {
  switch (kind) {
    case 'gate':
      return 'bg-violet-500';
    case 'evidence':
      return 'bg-emerald-500';
    case 'pr':
      return 'bg-blue-500';
    case 'test':
      return 'bg-sky-500';
    case 'agent':
      return 'bg-amber-500';
    case 'ci':
      return 'bg-rose-500';
    case 'sync':
      return 'bg-slate-400';
    case 'approval':
      return 'bg-indigo-500';
    default:
      return 'bg-slate-300';
  }
};

const fmt = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export default GitSyncPanel;