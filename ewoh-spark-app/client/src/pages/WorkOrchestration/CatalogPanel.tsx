import { useQuery } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkCatalog } from '../../api/work';
import { StatusBadge } from './shared';

const CatalogPanel = (): React.ReactElement => {
  const catalogQuery = useQuery({
    queryKey: queryKeys.workCatalog,
    queryFn: getWorkCatalog,
    staleTime: QUERY_STALE_TIME_MS,
  });

  return (
    <QueryState
      isLoading={catalogQuery.isLoading}
      isFetching={catalogQuery.isFetching}
      isError={catalogQuery.isError}
      isStale={catalogQuery.isStale}
      isEmpty={!catalogQuery.data}
      onRefresh={() => catalogQuery.refetch()}
      errorMessage={catalogQuery.error instanceof Error ? catalogQuery.error.message : '资产目录加载失败'}
      loadingMessage="正在读取资产目录"
      updatedAt={catalogQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <PackageSearch className="h-4 w-4 text-emerald-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">Final 6 资产目录</h2>
          <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
            {catalogQuery.data?.assets.length ?? 0} 个资产包
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">版本</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">来源</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {(catalogQuery.data?.assets ?? []).map((asset) => (
                <tr key={asset.packageId} className="hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3">
                    <div className="font-medium text-[hsl(220_14%_14%)]">{asset.name}</div>
                    <div className="font-mono text-xs text-[hsl(218_10%_42%)]">{asset.packageId}</div>
                  </td>
                  <td className="px-5 py-3 text-xs">{asset.packageType}</td>
                  <td className="px-5 py-3 font-mono text-xs">{asset.version}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={asset.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-xs">{asset.sourcePath ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </QueryState>
  );
};

export default CatalogPanel;