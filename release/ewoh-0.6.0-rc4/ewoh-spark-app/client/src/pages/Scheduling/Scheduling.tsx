import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Play, Sparkles, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { confirmPlan, generatePlans, getPlans } from '../../api/scheduler';
import { queryKeys } from '../../hooks/queryKeys';
import {
  OPERATIONAL_REFETCH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from '../../hooks/queryConfig';
import { getCurrentOperator } from '../../lib/auth';
import type { SchedulePlan } from '@shared/api.interface';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import QueryState from '../../components/QueryState';

type StatusFilter = 'all' | 'shadow' | 'confirmed';

const STATUS_FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: '全部', value: 'all' },
  { label: '待确认', value: 'shadow' },
  { label: '已确认', value: 'confirmed' },
];

function statusBadge(status: string): React.ReactElement {
  if (status === 'confirmed') {
    return (
      <Badge className="border-emerald-200 bg-emerald-100 text-emerald-700">
        已确认
      </Badge>
    );
  }
  if (status === 'rejected') {
    return <Badge variant="destructive">已拒绝</Badge>;
  }
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
      待确认
    </Badge>
  );
}

const Scheduling = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmReason, setConfirmReason] = useState('');

  const query = useQuery<SchedulePlan[]>({
    queryKey: queryKeys.schedulerPlans(),
    queryFn: () => getPlans(),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const rows = query.data ?? [];
  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    if (statusFilter === 'confirmed') return rows.filter((row) => row.status === 'confirmed');
    return rows.filter((row) => row.status !== 'confirmed' && row.status !== 'rejected');
  }, [rows, statusFilter]);

  const generateMutation = useMutation({
    mutationFn: () => generatePlans(),
    onSuccess: (data) => {
      toast.success(`已生成 ${data.length} 个调度方案`);
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlans() });
    },
    onError: (err) => {
      toast.error('方案生成失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (planId: string) =>
      confirmPlan(planId, {
        reason: confirmReason.trim() || '指挥中心确认',
        operator: getCurrentOperator(),
      }),
    onSuccess: () => {
      toast.success('方案已确认');
      setConfirmingId(null);
      setConfirmReason('');
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerPlans() });
    },
    onError: (err) => {
      toast.error('方案确认失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const mutationError =
    generateMutation.error instanceof Error
      ? generateMutation.error.message
      : confirmMutation.error instanceof Error
        ? confirmMutation.error.message
        : null;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">生产调度中心</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            方案生成、状态、确认与执行跟踪。
          </p>
        </div>
        <Button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          className="inline-flex items-center gap-2"
        >
          {generateMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {generateMutation.isPending ? '生成中...' : '生成方案'}
        </Button>
      </header>

      <div className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={statusFilter === filter.value ? 'default' : 'outline'}
            onClick={() => setStatusFilter(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {mutationError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {mutationError}
        </div>
      )}

      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        isError={query.isError}
        isStale={query.isStale}
        isEmpty={!query.data || filteredRows.length === 0}
        onRefresh={() => query.refetch()}
        errorMessage={query.error instanceof Error ? query.error.message : '数据加载失败'}
        loadingMessage="正在加载调度方案"
        emptyMessage="暂无调度方案，点击「生成方案」创建。"
        updatedAt={query.dataUpdatedAt}
      >
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {filteredRows.map((row) => (
            <div key={row.id} className="min-w-0 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[hsl(220_14%_14%)]">{row.planName}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[hsl(218_10%_42%)]">
                    {row.planId}
                  </p>
                </div>
                {statusBadge(row.status)}
              </div>
              <p className="mt-2 text-xs text-[hsl(218_10%_42%)]">
                策略：{row.strategy} · 节拍提升 {(row.taktImprovement * 100).toFixed(0)}%
              </p>
              <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-[hsl(220_14%_96%)] p-3 text-xs">
                {JSON.stringify(row.metricsJson ?? {}, null, 2)}
              </pre>

              {confirmingId === row.planId ? (
                <div className="mt-3 space-y-2">
                  <Input
                    value={confirmReason}
                    onChange={(e) => setConfirmReason(e.target.value)}
                    placeholder="确认原因（可选）"
                    className="h-8 text-xs"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={confirmMutation.isPending}
                      onClick={() => confirmMutation.mutate(row.planId)}
                    >
                      {confirmMutation.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="size-3" />
                      )}
                      {confirmMutation.isPending ? '确认中...' : '确认'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setConfirmingId(null);
                        setConfirmReason('');
                      }}
                    >
                      <X className="size-3" />
                      取消
                    </Button>
                  </div>
                </div>
              ) : row.status === 'confirmed' ? (
                <p className="mt-3 text-xs text-emerald-700">
                  已确认：{row.confirmedBy ?? '—'} ·{' '}
                  {row.confirmedAt
                    ? new Date(row.confirmedAt).toLocaleString('zh-CN', { hour12: false })
                    : '—'}
                </p>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() => setConfirmingId(row.planId)}
                >
                  <Play className="size-3" />
                  确认方案
                </Button>
              )}
            </div>
          ))}
        </div>
      </QueryState>
    </div>
  );
};

export default Scheduling;
