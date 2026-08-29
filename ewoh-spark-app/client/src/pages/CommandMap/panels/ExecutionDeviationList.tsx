// ExecutionDeviationList.tsx — 方案执行偏差列表（计划 vs 实际）。
//
// 消费 GET /api/scheduler/executions?planId=…（ewoh_scheduling_execution 事实表），
// 只展示带偏差类型（deviationType）的执行记录：状态文案 + 人员 + 偏差标签 +
// 计划/实际时间对比。30s 轮询；加载/错误重试/空态三态；无偏差时显示执行状态概览。

import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { listExecutions } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import {
  DEVIATION_LABELS,
  EXECUTION_STATUS_LABELS,
} from '../vm/executionFeedbackVM';
import { cn } from '@client/src/lib/utils';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return dayjs(d).format('HH:mm:ss');
}

interface ExecutionDeviationListProps {
  planId: string;
  personNameOf?: (id: string | null) => string | null;
}

export function ExecutionDeviationList({
  planId,
  personNameOf,
}: ExecutionDeviationListProps): React.ReactElement {
  const executionsQuery = useQuery({
    queryKey: queryKeys.schedulerExecutions(planId),
    queryFn: () => listExecutions({ planId }),
    refetchInterval: 30_000,
  });

  if (executionsQuery.isLoading) {
    return <div className="text-[10px] text-white/50">执行记录加载中…</div>;
  }
  if (executionsQuery.isError) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-white/50">
        <span>执行记录加载失败</span>
        <button
          type="button"
          onClick={() => executionsQuery.refetch()}
          className="underline underline-offset-2 hover:text-white/80"
        >
          重试
        </button>
      </div>
    );
  }
  const executions = executionsQuery.data?.executions ?? [];
  if (executions.length === 0) {
    return (
      <div className="text-[10px] text-white/50">
        暂无执行记录（方案派工后此处显示执行进度与偏差）
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="execution-deviation-list">
      <div className="text-[10px] font-semibold text-white/60">执行记录（计划 vs 实际）</div>
      {executions.slice(0, 8).map((ex) => (
        <div
          key={ex.executionId}
          className="flex items-baseline gap-1.5 rounded border border-white/5 bg-card/5 px-1.5 py-1 text-[10px]"
        >
          <span className="shrink-0 truncate text-white/45">
            {personNameOf?.(ex.personId) ?? ex.personId ?? '—'} · {ex.taskId}
          </span>
          <span
            className={cn(
              'shrink-0',
              ex.status === 'FAILED'
                ? 'text-risk-blocked-foreground'
                : ex.status === 'COMPLETED'
                  ? 'text-risk-normal-foreground'
                  : 'text-white/80',
            )}
          >
            {EXECUTION_STATUS_LABELS[ex.status] ?? ex.status}
          </span>
          {ex.deviationType ? (
            <span className="min-w-0 truncate text-risk-degraded-foreground/90">
              {DEVIATION_LABELS[ex.deviationType] ?? ex.deviationType}
            </span>
          ) : (
            <span className="min-w-0 truncate text-white/50">
              计划 {fmtTime(ex.plannedStartAt)} → 实际 {fmtTime(ex.actualStartAt)}
            </span>
          )}
        </div>
      ))}
      {executions.length > 8 && (
        <div className="text-[9px] text-white/40">另有 {executions.length - 8} 条执行记录未显示</div>
      )}
    </div>
  );
}
