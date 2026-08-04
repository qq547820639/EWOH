import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkGraph } from '../../api/work';
import { useVirtualList } from '../../lib/virtualList';
import { StatusBadge, formatTime } from './shared';
import { deriveAgentMetrics, type AgentMetrics } from './agentsDerived';

/** 行高估算（px），用于虚拟滚动。 */
const ROW_HEIGHT = 56;
const VIRTUAL_MAX_HEIGHT = 560;

/** 等待时长格式化：>1 天显示天与小时，否则显示小时与分钟。 */
const formatWait = (ms: number | null): string => {
  if (ms === null) return '—';
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${mins}分`;
  return `${mins}分`;
};

const AgentsPanel = (): React.ReactElement => {
  const graphQuery = useQuery({
    queryKey: queryKeys.workGraph,
    queryFn: getWorkGraph,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const graph = graphQuery.data;
  const agents = graph?.actors ?? [];

  // 基于 graph 数据推导各 Agent 的负载/失败率/等待/最近交接。
  const metrics = useMemo(() => {
    if (!graph) return new Map<string, ReturnType<typeof deriveAgentMetrics> extends Map<infer K, infer V> ? V : never>();
    return deriveAgentMetrics(graph.actors, graph.items, graph.evidence, graph.handoffs);
  }, [graph]);

  const { ref, range, slice } = useVirtualList<HTMLDivElement>({
    total: agents.length,
    itemHeight: ROW_HEIGHT,
  });
  const visibleRows = agents.slice(slice.start, slice.end);
  const renderedCount = slice.end - slice.start;
  const bottomSpacer = Math.max(
    0,
    range.totalHeight - range.offsetY - renderedCount * ROW_HEIGHT,
  );

  return (
    <QueryState
      isLoading={graphQuery.isLoading}
      isFetching={graphQuery.isFetching}
      isError={graphQuery.isError}
      isStale={graphQuery.isStale}
      isEmpty={!graphQuery.data}
      onRefresh={() => graphQuery.refetch()}
      errorMessage={graphQuery.error instanceof Error ? graphQuery.error.message : 'Agent 数据加载失败'}
      loadingMessage="正在读取 Agent 登记册"
      updatedAt={graphQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <Users className="h-4 w-4 text-sky-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">Agent 登记册</h2>
          {agents.length > 0 && (
            <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
              共 {agents.length} 条 · 虚拟化渲染 {renderedCount} 行
            </span>
          )}
        </div>
        <div
          ref={ref}
          className="overflow-auto"
          style={{ maxHeight: VIRTUAL_MAX_HEIGHT }}
          data-testid="agents-virtual-scroll"
        >
          <table className="w-full min-w-[1500px] text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-[hsl(220_14%_89%)] bg-white text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">ID</th>
                <th className="px-5 py-3 font-medium">角色</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">所有权</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">负载</th>
                <th className="px-5 py-3 font-medium">失败率</th>
                <th className="px-5 py-3 font-medium">等待时间</th>
                <th className="px-5 py-3 font-medium">工具权限</th>
                <th className="px-5 py-3 font-medium">预算</th>
                <th className="px-5 py-3 font-medium">最近交接</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {range.start > 0 && <tr aria-hidden style={{ height: range.offsetY }} />}
              {visibleRows.map((agent) => {
                const m = metrics.get(agent.actorId);
                return (
                  <tr key={agent.actorId} className="hover:bg-[hsl(220_14%_96%)]">
                    <td className="px-5 py-3 font-mono text-xs">{agent.actorId}</td>
                    <td className="px-5 py-3 font-medium">{agent.role}</td>
                    <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">{agent.kind}</td>
                    <td className="px-5 py-3 font-mono text-xs">{agent.ownership ?? '—'}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={agent.status ?? 'registered'} />
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`font-semibold ${
                          (m?.load ?? 0) > 5 ? 'text-amber-600' : (m?.load ?? 0) > 0 ? 'text-blue-600' : 'text-[hsl(218_10%_42%)]'
                        }`}
                      >
                        {m?.load ?? 0}
                      </span>
                      <span className="ml-1 text-xs text-[hsl(218_10%_42%)]">项</span>
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {m && m.total > 0 ? (
                        <span className={m.failureRate > 0 ? 'font-medium text-red-600' : 'text-emerald-700'}>
                          {m.failed}/{m.total}
                        </span>
                      ) : (
                        <span className="text-[hsl(218_10%_42%)]">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {m?.waitTimeMs != null ? (
                        <span className={m.waitTimeMs > 86400000 ? 'font-medium text-amber-600' : ''}>
                          {formatWait(m.waitTimeMs)}
                        </span>
                      ) : (
                        <span className="text-[hsl(218_10%_42%)]">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {agent.permissions && agent.permissions.length > 0 ? (
                        <span className="line-clamp-1 text-[hsl(218_10%_42%)]">
                          {agent.permissions.join(', ')}
                        </span>
                      ) : (
                        <span className="text-[hsl(218_10%_42%)]">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">—</td>
                    <td className="px-5 py-3 text-xs">
                      {m?.recentHandoff ? (
                        <div>
                          <div className="line-clamp-1 max-w-[220px] font-medium text-[hsl(220_14%_14%)]">
                            {m.recentHandoff.scope}
                          </div>
                          <div className="mt-0.5 text-[10px] text-[hsl(218_10%_42%)]">
                            {formatTime(m.recentHandoff.createdAt)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[hsl(218_10%_42%)]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {bottomSpacer > 0 && <tr aria-hidden style={{ height: bottomSpacer }} />}
            </tbody>
          </table>
        </div>
      </section>
    </QueryState>
  );
};

export default AgentsPanel;