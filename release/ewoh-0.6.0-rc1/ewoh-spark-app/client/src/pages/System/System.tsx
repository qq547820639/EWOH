import { useQuery } from '@tanstack/react-query';
import { listSystemConfigs, type SystemConfigRecord } from '../../api/system';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

const System = (): React.ReactElement => {
  const query = useQuery<SystemConfigRecord[]>({
    queryKey: queryKeys.systemConfigs,
    queryFn: listSystemConfigs,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">系统管理</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">组织化配置与敏感值脱敏展示。</p>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || rows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载系统配置"
        emptyMessage="暂无系统配置。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="break-all font-mono text-sm font-medium">{row.configKey}</span>
                <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">
                  {row.updatedAt
                    ? new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false })
                    : '—'}
                </span>
              </div>
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[hsl(220_14%_96%)] p-3 text-xs">
                {JSON.stringify(row.configValue, null, 2)}
              </pre>
              <p className="mt-2 text-xs text-[hsl(218_10%_42%)]">更新人：{row.updatedBy ?? '—'}</p>
            </div>
          ))}
        </div>
      </QueryState>
    </div>
  );
};

export default System;
