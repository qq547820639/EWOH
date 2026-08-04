import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { createWorkHandoff, listWorkHandoffs, updateWorkHandoffStatus } from '../../api/work';
import { formatTime, StatusBadge, WriteConfirmDialog } from './shared';

type HandoffAction = 'accepted' | 'rejected' | 'closed';

const HandoffsPanel = ({ writable }: { writable: boolean }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [handoffFrom, setHandoffFrom] = useState('AG-00');
  const [handoffTo, setHandoffTo] = useState('');
  const [handoffScope, setHandoffScope] = useState('');
  const [handoffAcceptance, setHandoffAcceptance] = useState('');
  const [pendingCreate, setPendingCreate] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: HandoffAction } | null>(
    null,
  );

  const handoffsQuery = useQuery({
    queryKey: queryKeys.workHandoffs,
    queryFn: listWorkHandoffs,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const handoffMutation = useMutation({
    mutationFn: () =>
      createWorkHandoff({
        fromActor: handoffFrom.trim(),
        toActor: handoffTo.trim(),
        scope: handoffScope.trim(),
        acceptance: handoffAcceptance.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workHandoffs });
      setHandoffTo('');
      setHandoffScope('');
      setHandoffAcceptance('');
      toast.success('交接已登记');
    },
  });
  const handoffStateMutation = useMutation({
    mutationFn: ({ handoffId, status, reason }: { handoffId: string; status: HandoffAction; reason?: string }) =>
      updateWorkHandoffStatus(handoffId, { status, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workHandoffs });
      toast.success('交接状态已更新');
    },
  });

  return (
    <QueryState
      isLoading={handoffsQuery.isLoading}
      isFetching={handoffsQuery.isFetching}
      isError={handoffsQuery.isError}
      isStale={handoffsQuery.isStale}
      isEmpty={!handoffsQuery.data}
      onRefresh={() => handoffsQuery.refetch()}
      errorMessage={handoffsQuery.error instanceof Error ? handoffsQuery.error.message : '交接数据加载失败'}
      loadingMessage="正在读取交接记录"
      updatedAt={handoffsQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <ArrowRightLeft className="h-4 w-4 text-blue-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">交接记录</h2>
        </div>
        {writable && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
            <input
              value={handoffFrom}
              onChange={(event) => setHandoffFrom(event.target.value)}
              placeholder="来源 Agent"
              className="h-9 w-40 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
            />
            <input
              value={handoffTo}
              onChange={(event) => setHandoffTo(event.target.value)}
              placeholder="接收 Agent"
              className="h-9 w-40 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
            />
            <input
              value={handoffScope}
              onChange={(event) => setHandoffScope(event.target.value)}
              placeholder="交接范围"
              className="h-9 w-64 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
            />
            <input
              value={handoffAcceptance}
              onChange={(event) => setHandoffAcceptance(event.target.value)}
              placeholder="验收标准"
              className="h-9 w-64 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
            />
            <button
              type="button"
              disabled={!handoffTo.trim() || !handoffScope.trim() || handoffMutation.isPending}
              onClick={() => setPendingCreate(true)}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-40"
            >
              登记交接
            </button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">交接</th>
                <th className="px-5 py-3 font-medium">范围</th>
                <th className="px-5 py-3 font-medium">来源</th>
                <th className="px-5 py-3 font-medium">接收</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">创建时间</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {(handoffsQuery.data ?? []).map((handoff) => (
                <tr key={handoff.handoffId} className="hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3 font-mono text-xs">{handoff.handoffId}</td>
                  <td className="px-5 py-3 font-medium">{handoff.scope}</td>
                  <td className="px-5 py-3">{handoff.fromActor}</td>
                  <td className="px-5 py-3">{handoff.toActor}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={handoff.status} />
                  </td>
                  <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                    {formatTime(handoff.createdAt)}
                  </td>
                  <td className="px-5 py-3">
                    {writable && handoff.status === 'open' && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={handoffStateMutation.isPending}
                          onClick={() => setPendingAction({ id: handoff.handoffId, action: 'accepted' })}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                        >
                          接收
                        </button>
                        <button
                          type="button"
                          disabled={handoffStateMutation.isPending}
                          onClick={() => setPendingAction({ id: handoff.handoffId, action: 'rejected' })}
                          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                        >
                          拒绝
                        </button>
                        <button
                          type="button"
                          disabled={handoffStateMutation.isPending}
                          onClick={() => setPendingAction({ id: handoff.handoffId, action: 'closed' })}
                          className="rounded-md border border-[hsl(220_14%_89%)] px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] disabled:opacity-40"
                        >
                          关闭
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <WriteConfirmDialog
        open={pendingCreate}
        title="确认登记交接"
        description={`${handoffFrom.trim()} → ${handoffTo.trim()} 交接「${handoffScope.trim()}」。`}
        actionLabel="确认登记"
        tone="primary"
        rollbackPoint="可通过「关闭」结束该交接。"
        onCancel={() => setPendingCreate(false)}
        onConfirm={() => {
          setPendingCreate(false);
          handoffMutation.mutate();
        }}
      />

      <WriteConfirmDialog
        open={Boolean(pendingAction)}
        title="确认交接状态"
        description={
          pendingAction
            ? `对交接 ${pendingAction.id} 执行「${
                pendingAction.action === 'accepted'
                  ? '接收'
                  : pendingAction.action === 'rejected'
                    ? '拒绝'
                    : '关闭'
              }」。`
            : ''
        }
        actionLabel="确认"
        tone={pendingAction?.action === 'rejected' ? 'danger' : 'primary'}
        rollbackPoint="对已关闭的交接需重新登记新交接以恢复。"
        onCancel={() => setPendingAction(null)}
        onConfirm={(reason) => {
          if (pendingAction) {
            handoffStateMutation.mutate({
              handoffId: pendingAction.id,
              status: pendingAction.action,
              reason: reason || undefined,
            });
          }
          setPendingAction(null);
        }}
      />
    </QueryState>
  );
};

export default HandoffsPanel;