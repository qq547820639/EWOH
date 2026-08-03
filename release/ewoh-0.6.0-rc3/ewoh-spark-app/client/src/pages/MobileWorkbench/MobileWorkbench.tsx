import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, QrCode, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  getMobileOrder,
  getWorkbench,
  scanWorkOrder,
  transitionMobileStep,
  type MobileWorkOrderDetail,
  type MobileWorkbenchStep,
} from '../../api/mobile';
import { getAuthUser } from '../../lib/auth';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import QueryState from '../../components/QueryState';

const STEP_ACTIONS = ['start', 'report', 'review', 'handover'] as const;

function stepStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '待开工',
    in_progress: '进行中',
    paused: '已暂停',
    reported: '已报工',
    reviewed: '已审核',
    handed_over: '已交收',
    cancelled: '已取消',
  };
  return labels[status] ?? status;
}

function orderStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: '草稿',
    released: '已释放',
    in_progress: '生产中',
    completed: '已完工',
    cancelled: '已取消',
  };
  return labels[status] ?? status;
}

const MobileWorkbench = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const personId = getAuthUser()?.userId ?? '';
  const [scanInput, setScanInput] = useState('');
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

  const workbenchQuery = useQuery({
    queryKey: queryKeys.mobileWorkbench(personId),
    queryFn: () => getWorkbench(personId),
    enabled: Boolean(personId),
  });

  const orderQuery = useQuery({
    queryKey: queryKeys.mobileOrder(activeOrderId ?? ''),
    queryFn: () => getMobileOrder(activeOrderId!),
    enabled: Boolean(activeOrderId),
  });

  const scanMutation = useMutation({
    mutationFn: (orderId: string) => scanWorkOrder(orderId),
    onSuccess: (detail) => {
      setActiveOrderId(detail.workOrder.scheduleTaskId);
      toast.success(`已扫码：${detail.workOrder.title}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
    },
    onError: (err) => {
      toast.error('扫码失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const transitionMutation = useMutation({
    mutationFn: ({
      orderId,
      stepId,
      action,
    }: {
      orderId: string;
      stepId: string;
      action: string;
    }) => transitionMobileStep(orderId, stepId, action),
    onSuccess: (step) => {
      toast.success(`工序 ${step.stepId} 已${stepStatusLabel(step.status)}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileOrder(activeOrderId ?? ''),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
    },
    onError: (err) => {
      toast.error('操作失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const activeOrder = orderQuery.data;
  const actionableSteps = useMemo(
    () => (activeOrder?.steps ?? []).filter((step) => step.status !== 'handed_over'),
    [activeOrder],
  );

  const handleScan = () => {
    const orderId = scanInput.trim();
    if (!orderId) {
      toast.error('请输入或扫码工单号');
      return;
    }
    scanMutation.mutate(orderId);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">移动工作台</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
          扫码查单、待办工序与移动端开工/报工/审核/交收。
        </p>
      </header>

      <div className="flex flex-col gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4 sm:flex-row">
        <div className="relative flex-1">
          <QrCode className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[hsl(218_10%_42%)]" />
          <Input
            value={scanInput}
            onChange={(event) => setScanInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleScan();
            }}
            placeholder="扫码或输入工单号"
            className="pl-9"
            aria-label="扫码或输入工单号"
          />
        </div>
        <Button
          onClick={handleScan}
          disabled={scanMutation.isPending}
          className="sm:w-28"
        >
          {scanMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <QrCode className="size-4" />
          )}
          扫码
        </Button>
      </div>

      <section aria-label="我的待办工序">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[hsl(220_14%_14%)]">我的待办工序</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => workbenchQuery.refetch()}
            disabled={workbenchQuery.isFetching}
          >
            <RefreshCw className="size-3" />
            刷新
          </Button>
        </div>
        <QueryState
          isLoading={workbenchQuery.isLoading}
          isFetching={workbenchQuery.isFetching}
          isError={workbenchQuery.isError}
          isEmpty={!workbenchQuery.data || workbenchQuery.data.length === 0}
          onRefresh={() => workbenchQuery.refetch()}
          errorMessage={
            workbenchQuery.error instanceof Error
              ? workbenchQuery.error.message
              : '加载失败'
          }
          loadingMessage="正在加载待办工序"
          emptyMessage="当前无待办工序。"
          updatedAt={workbenchQuery.dataUpdatedAt}
        >
          <div className="space-y-2">
            {(workbenchQuery.data ?? []).map((step) => (
              <button
                key={step.stepId}
                type="button"
                onClick={() => setActiveOrderId(step.scheduleTaskId)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3 text-left hover:border-[hsl(221_83%_53%)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
                    {step.name}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-[hsl(218_10%_42%)]">
                    {step.scheduleTaskId} / {step.stepId}
                  </p>
                </div>
                <Badge variant="outline">{stepStatusLabel(step.status)}</Badge>
              </button>
            ))}
          </div>
        </QueryState>
      </section>

      {activeOrder && (
        <section aria-label="已扫码工单">
          <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-[hsl(220_14%_14%)]">
                  {activeOrder.workOrder.title}
                </h2>
                <p className="mt-0.5 font-mono text-xs text-[hsl(218_10%_42%)]">
                  {activeOrder.workOrder.scheduleTaskId}
                </p>
              </div>
              <Badge>{orderStatusLabel(activeOrder.workOrder.status)}</Badge>
            </div>
            <div className="mt-3 space-y-2">
              {actionableSteps.map((step) => (
                <StepCard
                  key={step.stepId}
                  step={step}
                  pending={transitionMutation.isPending}
                  onAction={(action) =>
                    transitionMutation.mutate({
                      orderId: activeOrder.workOrder.scheduleTaskId,
                      stepId: step.stepId,
                      action,
                    })
                  }
                />
              ))}
              {actionableSteps.length === 0 && (
                <p className="rounded-lg bg-[hsl(220_14%_96%)] p-3 text-sm text-[hsl(218_10%_42%)]">
                  该工单所有工序已交收。
                </p>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

function StepCard({
  step,
  pending,
  onAction,
}: {
  step: MobileWorkbenchStep;
  pending: boolean;
  onAction: (action: string) => void;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_98%)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[hsl(220_14%_14%)]">
            {step.stepNo}. {step.name}
          </p>
          <p className="mt-0.5 font-mono text-xs text-[hsl(218_10%_42%)]">
            {step.stepId}
          </p>
        </div>
        <Badge variant="outline">{stepStatusLabel(step.status)}</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {STEP_ACTIONS.map((action) => {
          const nextStatus = {
            start: 'in_progress',
            report: 'reported',
            review: 'reviewed',
            handover: 'handed_over',
          }[action];
          const canRun =
            action === 'start'
              ? step.status === 'pending'
              : action === 'report'
                ? step.status === 'in_progress'
                : action === 'review'
                  ? step.status === 'reported'
                  : step.status === 'reviewed';
          return (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={!canRun || pending}
              onClick={() => onAction(action)}
            >
              {action === 'start'
                ? '开工'
                : action === 'report'
                  ? '报工'
                  : action === 'review'
                    ? '审核'
                    : '交收'}
              {pending && <Loader2 className="ml-1 size-3 animate-spin" />}
              <span className="sr-only">{nextStatus}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export default MobileWorkbench;
