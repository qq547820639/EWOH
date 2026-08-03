import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, RefreshCw, Users } from 'lucide-react';
import {
  getRoleWorkbench,
  type RoleWorkbenchRole,
} from '../../api/operations';
import { getAuthUser } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import QueryState from '../../components/QueryState';

const ROLES: Array<{ key: RoleWorkbenchRole; label: string }> = [
  { key: 'operator', label: '操作员' },
  { key: 'team_lead', label: '班组长' },
  { key: 'quality', label: '质检' },
  { key: 'equipment', label: '设备' },
  { key: 'manager', label: '管理者' },
];

function valueLabel(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '—';
  }
  return String(value);
}

export default function RoleWorkbench(): React.ReactElement {
  const [role, setRole] = useState<RoleWorkbenchRole>('manager');
  const personId = getAuthUser()?.userId ?? undefined;
  const workbenchQuery = useQuery({
    queryKey: queryKeys.roleWorkbench(role),
    queryFn: () => getRoleWorkbench(role, role === 'operator' ? personId : undefined),
    staleTime: 30_000,
  });

  const data = workbenchQuery.data?.data ?? {};
  const scalarEntries = useMemo(
    () =>
      Object.entries(data).filter(
        ([, value]) =>
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null ||
          value === undefined,
      ),
    [data],
  );
  const arrayEntries = useMemo(
    () => Object.entries(data).filter(([, value]) => Array.isArray(value)),
    [data],
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">角色任务工作台</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            按角色聚合任务、质量、设备与交付风险。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => workbenchQuery.refetch()}
          disabled={workbenchQuery.isFetching}
        >
          <RefreshCw className="size-3" />
          刷新
        </Button>
      </header>

      <div className="flex flex-wrap gap-1 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-1">
        {ROLES.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setRole(item.key)}
            aria-pressed={role === item.key}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
              role === item.key
                ? 'bg-[hsl(221_83%_53%)] text-white'
                : 'text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
            }`}
          >
            <Users className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      <QueryState
        isLoading={workbenchQuery.isLoading}
        isFetching={workbenchQuery.isFetching}
        isError={workbenchQuery.isError}
        isEmpty={scalarEntries.length === 0 && arrayEntries.length === 0}
        onRefresh={() => workbenchQuery.refetch()}
        errorMessage={
          workbenchQuery.error instanceof Error
            ? workbenchQuery.error.message
            : '加载失败'
        }
        loadingMessage="正在加载工作台"
        emptyMessage="当前角色暂无聚合数据。"
        updatedAt={workbenchQuery.dataUpdatedAt}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {scalarEntries.map(([key, value]) => (
            <div
              key={key}
              className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4"
            >
              <p className="text-xs text-[hsl(218_10%_42%)]">{key}</p>
              <p className="mt-1 text-2xl font-semibold text-[hsl(220_14%_14%)]">
                {valueLabel(value)}
              </p>
            </div>
          ))}
        </div>

        {arrayEntries.map(([key, value]) => (
          <section
            key={key}
            className="rounded-lg border border-[hsl(220_14%_89%)] bg-white"
          >
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-4 py-3">
              <ClipboardList className="size-4 text-[hsl(221_83%_53%)]" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">{key}</h2>
              <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                {(value as unknown[]).length} 条
              </span>
            </div>
            <div className="overflow-x-auto">
              {(value as unknown[]).length === 0 ? (
                <p className="px-4 py-3 text-sm text-[hsl(218_10%_42%)]">暂无记录。</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                    <tr>
                      {(value as Record<string, unknown>[])[0]
                        ? Object.keys((value as Record<string, unknown>[])[0]).map(
                            (column) => <th key={column} className="px-4 py-2 font-medium">{column}</th>,
                          )
                        : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                    {(value as Record<string, unknown>[]).map((row, index) => (
                      <tr key={index}>
                        {Object.entries(row).map(([column, cell]) => (
                          <td key={column} className="px-4 py-2 text-[hsl(220_14%_14%)]">
                            {typeof cell === 'object' ? JSON.stringify(cell) : valueLabel(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        ))}
      </QueryState>
    </div>
  );
}
