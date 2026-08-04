import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { listWorkRisks } from '../../api/work';
import { StatusBadge } from './shared';

const RisksPanel = (): React.ReactElement => {
  const risksQuery = useQuery({
    queryKey: queryKeys.workRisks,
    queryFn: listWorkRisks,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  return (
    <QueryState
      isLoading={risksQuery.isLoading}
      isFetching={risksQuery.isFetching}
      isError={risksQuery.isError}
      isStale={risksQuery.isStale}
      isEmpty={!risksQuery.data}
      onRefresh={() => risksQuery.refetch()}
      errorMessage={risksQuery.error instanceof Error ? risksQuery.error.message : '风险数据加载失败'}
      loadingMessage="正在读取风险登记"
      updatedAt={risksQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">风险登记</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">ID</th>
                <th className="px-5 py-3 font-medium">风险</th>
                <th className="px-5 py-3 font-medium">等级</th>
                <th className="px-5 py-3 font-medium">缓解</th>
                <th className="px-5 py-3 font-medium">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {(risksQuery.data ?? []).map((risk) => (
                <tr key={risk.id} className="hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3 font-mono text-xs">{risk.id}</td>
                  <td className="px-5 py-3">
                    <div className="font-medium text-[hsl(220_14%_14%)]">{risk.title}</div>
                    {risk.trigger && (
                      <div className="text-xs text-[hsl(218_10%_42%)]">{risk.trigger}</div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={risk.severity} />
                  </td>
                  <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                    {risk.mitigation ?? '—'}
                  </td>
                  <td className="px-5 py-3 text-xs">{risk.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </QueryState>
  );
};

export default RisksPanel;