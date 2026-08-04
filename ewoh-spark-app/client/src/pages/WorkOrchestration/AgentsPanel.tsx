import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { listWorkAgents } from '../../api/work';
import { useVirtualList } from '../../lib/virtualList';
import { StatusBadge } from './shared';

/** 行高估算（px），用于虚拟滚动。 */
const ROW_HEIGHT = 48;
const VIRTUAL_MAX_HEIGHT = 560;

const AgentsPanel = (): React.ReactElement => {
  const agentsQuery = useQuery({
    queryKey: queryKeys.workAgents,
    queryFn: listWorkAgents,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const agents = agentsQuery.data ?? [];
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
      isLoading={agentsQuery.isLoading}
      isFetching={agentsQuery.isFetching}
      isError={agentsQuery.isError}
      isStale={agentsQuery.isStale}
      isEmpty={!agentsQuery.data}
      onRefresh={() => agentsQuery.refetch()}
      errorMessage={agentsQuery.error instanceof Error ? agentsQuery.error.message : 'Agent 数据加载失败'}
      loadingMessage="正在读取 Agent 登记册"
      updatedAt={agentsQuery.dataUpdatedAt}
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
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-[hsl(220_14%_89%)] bg-white text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">ID</th>
                <th className="px-5 py-3 font-medium">角色</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">所有权</th>
                <th className="px-5 py-3 font-medium">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {range.start > 0 && (
                <tr aria-hidden style={{ height: range.offsetY }} />
              )}
              {visibleRows.map((agent) => (
                <tr key={agent.actorId} className="hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3 font-mono text-xs">{agent.actorId}</td>
                  <td className="px-5 py-3 font-medium">{agent.role}</td>
                  <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">{agent.kind}</td>
                  <td className="px-5 py-3 font-mono text-xs">{agent.ownership ?? '—'}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={agent.status ?? 'registered'} />
                  </td>
                </tr>
              ))}
              {bottomSpacer > 0 && <tr aria-hidden style={{ height: bottomSpacer }} />}
            </tbody>
          </table>
        </div>
      </section>
    </QueryState>
  );
};

export default AgentsPanel;