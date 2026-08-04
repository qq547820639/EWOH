import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, ListChecks, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkGraph, listWorkGates, recordGateDecision, recordGateDecisions } from '../../api/work';
import { StatusBadge, useUrlParam, WriteConfirmDialog } from './shared';

type Decision = 'approved' | 'rejected' | 'conditional';

interface PendingConfirm {
  gateId: string;
  decision: Decision;
}

const GatesPanel = ({ writable }: { writable: boolean }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [gateStatusFilter, setGateStatusFilter] = useUrlParam('gateStatus');
  const [decisionMap, setDecisionMap] = useState<Record<string, string>>({});
  const [batchDecision, setBatchDecision] = useState<Decision>('approved');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [batchPending, setBatchPending] = useState(false);

  const gatesQuery = useQuery({
    queryKey: queryKeys.workGates,
    queryFn: listWorkGates,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const graphQuery = useQuery({
    queryKey: queryKeys.workGraph,
    queryFn: getWorkGraph,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const gateDecisionMutation = useMutation({
    mutationFn: ({ gateId, decision }: { gateId: string; decision: Decision }) =>
      recordGateDecision(gateId, { decision }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workGates });
      queryClient.invalidateQueries({ queryKey: queryKeys.workOverview });
      toast.success(`已记录 ${variables.gateId} 的决定`);
    },
  });
  const batchDecisionMutation = useMutation({
    mutationFn: (gateIds: string[]) =>
      recordGateDecisions(gateIds, { decision: batchDecision }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workGates });
      queryClient.invalidateQueries({ queryKey: queryKeys.workOverview });
      toast.success('批量决定已记录');
    },
  });

  const filteredGates = useMemo(
    () =>
      (gatesQuery.data ?? []).filter(
        (gate) => !gateStatusFilter || gate.calculatedStatus === gateStatusFilter,
      ),
    [gatesQuery.data, gateStatusFilter],
  );

  // 基于图 edges 反向传播计算某门禁决定将影响的下游节点数量。
  const downstreamCount = useMemo(() => {
    const items = graphQuery.data?.items ?? [];
    const edges = graphQuery.data?.edges ?? [];
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.from) ?? [];
      list.push(edge.to);
      adjacency.set(edge.from, list);
    }
    const idSet = new Set(items.map((item) => item.id));
    const count = (gateId: string): number => {
      const seen = new Set<string>();
      const queue = [gateId];
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) continue;
        for (const target of adjacency.get(id) ?? []) {
          if (!seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        }
      }
      return [...seen].filter((id) => idSet.has(id)).length;
    };
    return count;
  }, [graphQuery.data]);

  const confirmDecision = (gateId: string, decision: Decision, reason: string) => {
    setPendingConfirm(null);
    gateDecisionMutation.mutate({ gateId, decision });
    // TODO: 后端记录决定接口未接受 reason 字段，reason 仅作 UI 侧操作说明。
    void reason;
  };

  const confirmBatch = () => {
    setBatchPending(false);
    batchDecisionMutation.mutate(filteredGates.map((gate) => gate.gateId));
  };

  return (
    <QueryState
      isLoading={gatesQuery.isLoading}
      isFetching={gatesQuery.isFetching}
      isError={gatesQuery.isError}
      isStale={gatesQuery.isStale}
      isEmpty={!gatesQuery.data}
      onRefresh={() => gatesQuery.refetch()}
      errorMessage={gatesQuery.error instanceof Error ? gatesQuery.error.message : '门禁数据加载失败'}
      loadingMessage="正在计算门禁规则"
      updatedAt={gatesQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <ListChecks className="h-4 w-4 text-emerald-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">门禁计算</h2>
          <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
            {gatesQuery.data?.length ?? 0} 个门禁
          </span>
          <select
            value={gateStatusFilter}
            onChange={(event) => setGateStatusFilter(event.target.value)}
            aria-label="按门禁规则状态筛选"
            className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
          >
            <option value="">全部状态</option>
            <option value="passed">passed</option>
            <option value="in_progress">in_progress</option>
            <option value="requires_approval">requires_approval</option>
            <option value="pending">pending</option>
            <option value="approved">approved</option>
          </select>
          {writable && (
            <>
              <select
                value={batchDecision}
                onChange={(event) => setBatchDecision(event.target.value as Decision)}
                aria-label="批量门禁决定"
                className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
              >
                <option value="approved">批准</option>
                <option value="rejected">驳回</option>
                <option value="conditional">条件批准</option>
              </select>
              <button
                type="button"
                disabled={filteredGates.length === 0}
                onClick={() => setBatchPending(true)}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                批量记录 {filteredGates.length}
              </button>
            </>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">门禁</th>
                <th className="px-5 py-3 font-medium">规则状态</th>
                <th className="px-5 py-3 font-medium">人工决定</th>
                <th className="px-5 py-3 font-medium">条件</th>
                <th className="px-5 py-3 font-medium">影响预览</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {filteredGates.map((gate) => {
                const chosen = (decisionMap[gate.gateId] ?? 'approved') as Decision;
                const impact = downstreamCount(gate.gateId);
                return (
                  <tr key={gate.gateId} className="hover:bg-[hsl(220_14%_96%)]">
                    <td className="px-5 py-3">
                      <div className="font-medium text-[hsl(220_14%_14%)]">
                        {gate.gateId}
                      </div>
                      <div className="text-xs text-[hsl(218_10%_42%)]">{gate.title}</div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={gate.calculatedStatus} />
                    </td>
                    <td className="px-5 py-3">
                      {gate.humanDecision ? (
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={gate.humanDecision} />
                          <span className="text-[10px] text-[hsl(218_10%_42%)]">
                            {gate.approver ? `审批人 ${gate.approver}` : ''}
                            {gate.decidedAt ? ` · ${new Date(gate.decidedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-[hsl(218_10%_42%)]">未决定</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                      {gate.conditions?.slice(0, 3).join('；') || '—'}
                    </td>
                    <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                      {impact > 0 ? `影响 ${impact} 个下游节点` : '无下游节点'}
                    </td>
                    <td className="px-5 py-3">
                      {writable && (
                        <div className="flex items-center gap-2">
                          <select
                            value={chosen}
                            onChange={(event) =>
                              setDecisionMap((current) => ({
                                ...current,
                                [gate.gateId]: event.target.value,
                              }))
                            }
                            className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
                          >
                            <option value="approved">批准</option>
                            <option value="rejected">驳回</option>
                            <option value="conditional">条件批准</option>
                          </select>
                          <button
                            type="button"
                            disabled={gateDecisionMutation.isPending}
                            onClick={() =>
                              setPendingConfirm({ gateId: gate.gateId, decision: chosen })
                            }
                            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                          >
                            记录
                          </button>
                          <button
                            type="button"
                            title="撤销需后端提供撤销 API（TODO）"
                            onClick={() =>
                              toast.info('撤销功能待后端支持：需新增 gate 撤销/回滚 API（TODO）')
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(220_14%_89%)] px-2.5 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            撤销
                          </button>
                          <button
                            type="button"
                            title="门禁完整历史记录需后端提供历史 API（TODO）"
                            onClick={() =>
                              toast.info('门禁历史需后端支持：当前仅返回最新一次人工决定（TODO）')
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(220_14%_89%)] px-2.5 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
                          >
                            <History className="h-3.5 w-3.5" />
                            历史
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 单条记录确认：展示 actor/reason/source/timestamp/rollback point */}
      <WriteConfirmDialog
        open={Boolean(pendingConfirm)}
        title="确认记录门禁决定"
        description={
          pendingConfirm
            ? `对 ${pendingConfirm.gateId} 执行「${
                pendingConfirm.decision === 'approved'
                  ? '批准'
                  : pendingConfirm.decision === 'rejected'
                    ? '驳回'
                    : '条件批准'
              }」。`
            : ''
        }
        actionLabel="确认记录"
        tone="success"
        rollbackPoint="暂不支持撤销；如需回滚需后端提供 gate 撤销 API（TODO）。"
        onCancel={() => setPendingConfirm(null)}
        onConfirm={(reason) => {
          if (!pendingConfirm) return;
          confirmDecision(pendingConfirm.gateId, pendingConfirm.decision, reason);
        }}
      />

      {/* 批量记录确认 */}
      <WriteConfirmDialog
        open={batchPending}
        title="批量记录门禁决定"
        description={`将批量对 ${filteredGates.length} 个门禁执行「${
          batchDecision === 'approved' ? '批准' : batchDecision === 'rejected' ? '驳回' : '条件批准'
        }」。`}
        actionLabel="批量确认"
        tone="success"
        rollbackPoint="暂不支持批量撤销；如需回滚需后端提供 gate 撤销 API（TODO）。"
        onCancel={() => setBatchPending(false)}
        onConfirm={confirmBatch}
      />
    </QueryState>
  );
};

export default GatesPanel;