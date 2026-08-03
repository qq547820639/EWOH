import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { listModels, transitionModel, type ModelRecord } from '../../api/models';
import { queryKeys } from '../../hooks/queryKeys';
import {
  ADMIN_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import QueryState from '../../components/QueryState';
import { Button } from '@client/src/components/ui/button';

const actionFor = (status: string | null): { label: string; action: string } | null => {
  switch (status) {
    case 'candidate':
      return { label: '提交评审', action: 'submit_review' };
    case 'reviewing':
      return { label: '通过评审', action: 'approve_review' };
    case 'shadow':
      return { label: '激活', action: 'activate' };
    case 'active':
      return { label: '退役', action: 'retire' };
    default:
      return null;
  }
};

const ModelManagement = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const query = useQuery<ModelRecord[]>({
    queryKey: queryKeys.models,
    queryFn: listModels,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const transitionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => transitionModel(id, action),
    onSuccess: () => {
      toast.success('模型状态已更新');
      queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (err) => {
      toast.error('状态更新失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">模型管理</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">模型注册、评审、影子、激活与退役。</p>
      </header>

      {transitionMutation.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {transitionMutation.error instanceof Error
            ? transitionMutation.error.message
            : '状态更新失败'}
        </div>
      )}

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || rows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载模型数据"
        emptyMessage="暂无模型记录。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="overflow-x-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
              <tr>
                <th className="px-5 py-3 font-medium">模型</th>
                <th className="px-5 py-3 font-medium">版本</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(220_14%_89%)]">
              {rows.map((row) => {
                const next = actionFor(row.status);
                const busy =
                  transitionMutation.isPending && transitionMutation.variables?.id === row.id;
                return (
                  <tr key={row.id} className="hover:bg-[hsl(220_14%_96%)]">
                    <td className="px-5 py-3">
                      <p className="font-medium text-[hsl(220_14%_14%)]">{row.modelName}</p>
                      <p className="font-mono text-xs text-[hsl(218_10%_42%)]">{row.modelId}</p>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{row.version}</td>
                    <td className="px-5 py-3 text-[hsl(218_10%_42%)]">{row.type}</td>
                    <td className="px-5 py-3">{row.status ?? '—'}</td>
                    <td className="px-5 py-3">
                      {next && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => transitionMutation.mutate({ id: row.id, action: next.action })}
                          className="inline-flex items-center gap-1.5"
                        >
                          {busy && <Loader2 className="size-3 animate-spin" />}
                          {busy ? '处理中' : next.label}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryState>
    </div>
  );
};

export default ModelManagement;
