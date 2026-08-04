import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, ListChecks, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import {
  getWorkGraph,
  getGateHistory,
  listWorkGates,
  recordGateDecision,
  recordGateDecisions,
  revokeGateDecision,
  type GateHistoryEntry,
} from '../../api/work';
import { StatusBadge, useUrlParam, WriteConfirmDialog } from './shared';
import { BatchGatePreviewDialog } from './GateBatchPreviewDialog';
import {
  computeDownstreamCounts,
  deriveGateBatchPreview,
} from './gateBatchModel';

type Decision = 'approved' | 'rejected' | 'conditional';

interface PendingConfirm {
  gateId: string;
  decision: Decision;
}

const GateHistoryDialog = ({
  gateId,
  entries,
  onClose,
}: {
  gateId: string;
  entries: GateHistoryEntry[];
  onClose: () => void;
}): React.ReactElement | null => {
  if (!gateId) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${gateId} 门禁历史`}
    >
      <div className="w-full max-w-2xl rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[hsl(220_14%_14%)]">
            {gateId} 门禁历史
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[hsl(220_14%_89%)] px-3 py-1 text-sm text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            关闭
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="mt-4 text-sm text-[hsl(218_10%_42%)]">该门禁暂无历史记录。</p>
        ) : (
          <div className="mt-4 max-h-[420px] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                <tr>
                  <th className="px-3 py-2 font-medium">动作</th>
                  <th className="px-3 py-2 font-medium">决定</th>
                  <th className="px-3 py-2 font-medium">操作者</th>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">备注</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                {entries.map((entry, index) => (
                  <tr key={`${entry.decidedAt ?? entry.revokedAt ?? index}-${index}`}>
                    <td className="px-3 py-2">
                      {entry.action === 'revoked' ? (
                        <span className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                          撤销
                        </span>
                      ) : (
                        <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                          决定
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={entry.decision} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[hsl(218_10%_42%)]">
                      {entry.revokedBy ?? entry.approver ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-[hsl(218_10%_42%)]">
                      {new Date(entry.revokedAt ?? entry.decidedAt ?? '').toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    </td>
                    <td className="px-3 py-2 text-xs text-[hsl(218_10%_42%)]">
                      {entry.reason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const GatesPanel = ({ writable }: { writable: boolean }): React.ReactElement => {
  const queryClient = useQueryClient();
  const [gateStatusFilter, setGateStatusFilter] = useUrlParam('gateStatus');
  const [decisionMap, setDecisionMap] = useState<Record<string, string>>({});
  const [batchDecision, setBatchDecision] = useState<Decision>('approved');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [batchPending, setBatchPending] = useState(false);
  const [revokePending, setRevokePending] = useState<string | null>(null);
  const [historyGateId, setHistoryGateId] = useState<string | null>(null);

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
  const revokeMutation = useMutation({
    mutationFn: ({ gateId, reason }: { gateId: string; reason: string }) =>
      revokeGateDecision(gateId, { reason }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workGates });
      queryClient.invalidateQueries({ queryKey: queryKeys.workOverview });
      queryClient.invalidateQueries({ queryKey: queryKeys.workGateHistory(data.gateId) });
      toast.success(
        data.restored
          ? `已撤销 ${data.gateId} 并回滚为「${data.restored.decision}」`
          : `已撤销 ${data.gateId} 的决定`,
      );
    },
  });
  const historyQuery = useQuery({
    queryKey: queryKeys.workGateHistory(historyGateId ?? ''),
    queryFn: () => getGateHistory(historyGateId ?? ''),
    enabled: Boolean(historyGateId),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const filteredGates = useMemo(
    () =>
      (gatesQuery.data ?? []).filter(
        (gate) => !gateStatusFilter || gate.calculatedStatus === gateStatusFilter,
      ),
    [gatesQuery.data, gateStatusFilter],
  );

  // 基于图 edges 反向传播计算某门禁决定将影响的下游节点数量。
  const downstreamCounts = useMemo(() => {
    const items = graphQuery.data?.items ?? [];
    const edges = graphQuery.data?.edges ?? [];
    return computeDownstreamCounts(edges, new Set(items.map((item) => item.id)));
  }, [graphQuery.data]);

  // 批量预览：结合 graph 的项目/证据/边，推导每个门禁的影响范围、缺失证据与可执行性。
  const batchPreview = useMemo(() => {
    if (!graphQuery.data) {
      return {
        rows: [],
        executableCount: 0,
        nonExecutableCount: 0,
        missingEvidenceCount: 0,
        affectedDownstreamTotal: 0,
      };
    }
    return deriveGateBatchPreview(graphQuery.data, filteredGates);
  }, [graphQuery.data, filteredGates]);

  const confirmDecision = (gateId: string, decision: Decision, reason: string) => {
    setPendingConfirm(null);
    gateDecisionMutation.mutate({ gateId, decision });
    // TODO: 后端记录决定接口未接受 reason 字段，reason 仅作 UI 侧操作说明。
    void reason;
  };

  const confirmBatch = () => {
    setBatchPending(false);
    const executable = batchPreview.rows
      .filter((row) => row.executable)
      .map((row) => row.gateId);
    if (executable.length === 0) {
      toast.error('没有可执行的门禁，已跳过批量记录');
      return;
    }
    batchDecisionMutation.mutate(executable);
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
                const impact = downstreamCounts.get(gate.gateId) ?? 0;
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
                            title="撤销该门禁的当前决定（可回滚到前一条决定）"
                            disabled={!gate.humanDecision || revokeMutation.isPending}
                            onClick={() => setRevokePending(gate.gateId)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(220_14%_89%)] px-2.5 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)] disabled:opacity-40"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            撤销
                          </button>
                          <button
                            type="button"
                            title="查看该门禁的完整历史记录"
                            onClick={() => setHistoryGateId(gate.gateId)}
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
        rollbackPoint="批准后可通过「撤销」按钮回滚；撤销会恢复该门禁的前一条决定（如有）。"
        onCancel={() => setPendingConfirm(null)}
        onConfirm={(reason) => {
          if (!pendingConfirm) return;
          confirmDecision(pendingConfirm.gateId, pendingConfirm.decision, reason);
        }}
      />

      {/* 批量记录预览：展示影响范围、缺失证据与不可执行原因，仅对可执行门禁生效 */}
      <BatchGatePreviewDialog
        open={batchPending}
        rows={batchPreview.rows}
        decision={batchDecision}
        onCancel={() => setBatchPending(false)}
        onConfirm={confirmBatch}
      />

      {/* 撤销确认 */}
      <WriteConfirmDialog
        open={Boolean(revokePending)}
        title="确认撤销门禁决定"
        description={
          revokePending
            ? `对 ${revokePending} 执行撤销。${gatesQuery.data?.find((g) => g.gateId === revokePending)?.humanDecision ? '' : '（当前无决定）'}`
            : ''
        }
        actionLabel="确认撤销"
        tone="danger"
        rollbackPoint="撤销会移除此门禁的当前决定；若存在前一条决定则自动回滚恢复。"
        onCancel={() => setRevokePending(null)}
        onConfirm={(reason) => {
          if (!revokePending) return;
          revokeMutation.mutate({ gateId: revokePending, reason });
          setRevokePending(null);
        }}
      />

      {/* 历史弹窗 */}
      <GateHistoryDialog
        gateId={historyGateId ?? ''}
        entries={historyQuery.data ?? []}
        onClose={() => setHistoryGateId(null)}
      />
    </QueryState>
  );
};

export default GatesPanel;