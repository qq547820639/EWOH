import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { listPersonnel } from '../../api/organization';
import type { PersonnelInfo } from '@shared/api.interface';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';

const riskLabel = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const Personnel = (): React.ReactElement => {
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const query = useQuery<PersonnelInfo[]>({
    queryKey: queryKeys.personnel({ keyword: debouncedKeyword || undefined }),
    queryFn: () => listPersonnel({ keyword: debouncedKeyword || undefined }),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">人员与外骨骼</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            人员档案、组织归属、技能与健康风险概览。
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[hsl(218_10%_42%)]" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索姓名 / 工号 / 岗位"
            aria-label="搜索人员"
            className="h-9 w-full rounded-lg border border-[hsl(220_14%_89%)] bg-white pl-9 pr-3 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
          />
        </div>
      </header>

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || rows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载人员数据"
        emptyMessage="暂无人员记录。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="overflow-x-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">姓名</th>
                <th className="px-5 py-3 font-medium">工号</th>
                <th className="px-5 py-3 font-medium">组织</th>
                <th className="px-5 py-3 font-medium">岗位</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">风险</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {rows.map((person) => (
                <tr key={person.id} className="hover:bg-[hsl(220_14%_96%)]">
                  <td className="px-5 py-3 font-medium text-[hsl(220_14%_14%)]">{person.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{person.employeeNo}</td>
                  <td className="px-5 py-3 text-[hsl(218_10%_42%)]">{person.orgId ?? '-'}</td>
                  <td className="px-5 py-3">{person.position ?? '-'}</td>
                  <td className="px-5 py-3">{person.status ?? '-'}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${
                        person.riskLevel === 'high'
                          ? 'bg-red-100 text-red-700'
                          : person.riskLevel === 'medium'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {riskLabel[person.riskLevel ?? 'low']}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </div>
  );
};

export default Personnel;
