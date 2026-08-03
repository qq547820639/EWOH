import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, QrCode, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  getMobileOrder,
  getWorkbench,
  inspectMobileStep,
  scanWorkOrder,
  transitionMobileStep,
  type MobileWorkOrderDetail,
  type MobileWorkbenchStep,
} from '../../api/mobile';
import { uploadFile } from '../../api/files';
import { getAuthUser } from '../../lib/auth';
import {
  appendPendingAction,
  readPendingActions,
  removePendingAction,
} from '../../lib/offlineQueue';
import { dataUrlToFile, fileToDataUrl } from '../../lib/attachmentDataUrl';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import QueryState from '../../components/QueryState';
import { buildExceptionBody } from './exceptionPayload';

const STEP_ACTIONS = ['start', 'report', 'pause', 'resume', 'review', 'handover'] as const;
const QUALITY_RESULTS = ['pass', 'fail', 'rework'] as const;

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
  const [exceptionOpen, setExceptionOpen] = useState<Record<string, boolean>>({});
  const [exceptionNote, setExceptionNote] = useState<Record<string, string>>({});
  const [exceptionFile, setExceptionFile] = useState<Record<string, File | null>>({});
  const [qcOpen, setQcOpen] = useState<Record<string, boolean>>({});
  const [qcResult, setQcResult] = useState<
    Record<string, 'pass' | 'fail' | 'rework' | undefined>
  >({});
  const [qcNote, setQcNote] = useState<Record<string, string>>({});
  const [failedMutation, setFailedMutation] = useState<
    Record<string, { kind: 'transition' | 'inspection'; variables: unknown } | undefined>
  >({});
  const [isOnline, setIsOnline] = useState(
    () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  );
  const [pendingCount, setPendingCount] = useState(() => readPendingActions().length);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      return undefined;
    }
    let cancelled = false;
    const flushPending = async () => {
      const queue = readPendingActions();
      if (queue.length === 0) {
        return;
      }
      for (const item of queue) {
        if (cancelled) {
          return;
        }
        try {
          if (item.type === 'transition') {
            let body = item.body;
            if (item.attachment) {
              const file = dataUrlToFile(
                item.attachment.dataUrl,
                item.attachment.name,
                item.attachment.contentType,
              );
              const record = await uploadFile(file, `exception-${item.stepId}`);
              body = {
                ...(item.body ?? {}),
                attachments: [
                  {
                    id: record.id,
                    filename: record.filename,
                    contentType: record.contentType,
                  },
                ],
              };
            }
            await transitionMobileStep(
              item.orderId,
              item.stepId,
              item.action ?? '',
              body,
            );
          } else {
            await inspectMobileStep(item.orderId, item.stepId, {
              result: (item.body?.result as 'pass' | 'fail' | 'rework') ?? 'pass',
              note: item.body?.note as string | undefined,
            });
          }
          removePendingAction(item.id);
        } catch (error) {
          toast.error(`待同步操作失败：${item.stepId}`, {
            description: error instanceof Error ? error.message : undefined,
          });
          return;
        }
      }
      setPendingCount(readPendingActions().length);
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
    };
    flushPending();
    return () => {
      cancelled = true;
    };
  }, [isOnline, personId, queryClient]);

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
      body,
    }: {
      orderId: string;
      stepId: string;
      action: string;
      body?: Record<string, unknown>;
    }) => transitionMobileStep(orderId, stepId, action, body),
    onSuccess: (step, variables) => {
      toast.success(`工序 ${step.stepId} 已${stepStatusLabel(step.status)}`);
      setFailedMutation((current) => ({ ...current, [step.stepId]: undefined }));
      if (variables.action === 'pause') {
        setExceptionNote((current) => ({ ...current, [step.stepId]: '' }));
        setExceptionOpen((current) => ({ ...current, [step.stepId]: false }));
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileOrder(activeOrderId ?? ''),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
    },
    onError: (err, variables) => {
      setFailedMutation((current) => ({
        ...current,
        [variables.stepId]: { kind: 'transition', variables },
      }));
      toast.error('操作失败', {
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const inspectMutation = useMutation({
    mutationFn: ({
      orderId,
      stepId,
      result,
      note,
    }: {
      orderId: string;
      stepId: string;
      result: 'pass' | 'fail' | 'rework';
      note?: string;
    }) => inspectMobileStep(orderId, stepId, { result, note }),
    onSuccess: ({ stepId, result }) => {
      toast.success(`质检 ${stepId} 已记录：${result}`);
      setFailedMutation((current) => ({ ...current, [stepId]: undefined }));
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileOrder(activeOrderId ?? ''),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
      setQcOpen((current) => ({ ...current, [stepId]: false }));
      setQcNote((current) => ({ ...current, [stepId]: '' }));
    },
    onError: (err, variables) => {
      setFailedMutation((current) => ({
        ...current,
        [variables.stepId]: { kind: 'inspection', variables },
      }));
      toast.error('质检提交失败', {
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

  const submitTransition = (
    orderId: string,
    stepId: string,
    action: string,
    body?: Record<string, unknown>,
  ) => {
    if (isOnline) {
      transitionMutation.mutate({ orderId, stepId, action, body });
      return;
    }
    appendPendingAction({ type: 'transition', orderId, stepId, action, body });
    setPendingCount(readPendingActions().length);
    toast.info('已加入待同步队列，联网后自动提交');
  };

  const submitInspection = (
    orderId: string,
    stepId: string,
    result: 'pass' | 'fail' | 'rework',
    note?: string,
  ) => {
    if (isOnline) {
      inspectMutation.mutate({ orderId, stepId, result, note });
      return;
    }
    appendPendingAction({
      type: 'inspection',
      orderId,
      stepId,
      body: { result, note: note ?? null },
    });
    setPendingCount(readPendingActions().length);
    toast.info('质检已加入待同步队列');
  };

  const handleException = async (stepId: string) => {
    const note = exceptionNote[stepId]?.trim();
    if (!note) {
      toast.error('请填写异常说明');
      return;
    }
    const file = exceptionFile[stepId] ?? null;
    if (file && !isOnline) {
      try {
        const dataUrl = await fileToDataUrl(file);
        if (dataUrl.length > 2_500_000) {
          toast.error('离线照片过大，请压缩后重试（约 2MB 以内）');
          return;
        }
        appendPendingAction({
          type: 'transition',
          orderId: activeOrder!.workOrder.scheduleTaskId,
          stepId,
          action: 'pause',
          body: buildExceptionBody(note),
          attachment: {
            name: file.name,
            contentType: file.type || 'image/jpeg',
            dataUrl,
          },
        });
        setPendingCount(readPendingActions().length);
        toast.info('异常及照片已加入待同步队列');
        return;
      } catch (error) {
        toast.error('照片读取失败', {
          description: error instanceof Error ? error.message : undefined,
        });
        return;
      }
    }
    let body = buildExceptionBody(note);
    if (file) {
      try {
        const record = await uploadFile(file, `exception-${stepId}`);
        body = buildExceptionBody(note, {
          id: record.id,
          filename: record.filename,
          contentType: record.contentType,
        });
      } catch (error) {
        toast.error('照片上传失败', {
          description: error instanceof Error ? error.message : undefined,
        });
        return;
      }
    }
    submitTransition(activeOrder!.workOrder.scheduleTaskId, stepId, 'pause', body);
  };

  const handleInspect = (stepId: string) => {
    const result = qcResult[stepId];
    if (!result) {
      toast.error('请选择质检结果');
      return;
    }
    submitInspection(
      activeOrder!.workOrder.scheduleTaskId,
      stepId,
      result,
      qcNote[stepId]?.trim() || undefined,
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">移动工作台</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-sm text-[hsl(218_10%_42%)]">
            扫码查单、待办工序与移动端开工/报工/审核/交收。
          </p>
          {pendingCount > 0 && (
            <Badge variant="outline">待同步 {pendingCount}</Badge>
          )}
        </div>
      </header>

      {!isOnline && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
        >
          当前处于离线状态，操作会加入待同步队列，联网后自动提交。
        </div>
      )}

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
              {actionableSteps.map((step) => {
                const failed = failedMutation[step.stepId];
                const stepError = failed
                  ? failed.kind === 'transition'
                    ? (transitionMutation.error ?? null)
                    : (inspectMutation.error ?? null)
                  : null;
                return (
                  <StepCard
                    key={step.stepId}
                    step={step}
                    pending={transitionMutation.isPending || inspectMutation.isPending}
                    error={stepError}
                    exceptionOpen={Boolean(exceptionOpen[step.stepId])}
                    exceptionNote={exceptionNote[step.stepId] ?? ''}
                    exceptionFile={exceptionFile[step.stepId] ?? null}
                    qcOpen={Boolean(qcOpen[step.stepId])}
                    qcResult={qcResult[step.stepId]}
                    qcNote={qcNote[step.stepId] ?? ''}
                    onExceptionNoteChange={(value) =>
                      setExceptionNote((current) => ({ ...current, [step.stepId]: value }))
                    }
                    onExceptionFileChange={(file) =>
                      setExceptionFile((current) => ({ ...current, [step.stepId]: file }))
                    }
                    onExceptionOpenChange={(open) =>
                      setExceptionOpen((current) => ({ ...current, [step.stepId]: open }))
                    }
                    onQcOpenChange={(open) =>
                      setQcOpen((current) => ({ ...current, [step.stepId]: open }))
                    }
                    onQcResultChange={(value) =>
                      setQcResult((current) => ({ ...current, [step.stepId]: value }))
                    }
                    onQcNoteChange={(value) =>
                      setQcNote((current) => ({ ...current, [step.stepId]: value }))
                    }
                    onSubmitException={() => handleException(step.stepId)}
                    onSubmitInspection={() => handleInspect(step.stepId)}
                    onRetry={() => {
                      const target = failedMutation[step.stepId];
                      if (!target) {
                        return;
                      }
                      if (target.kind === 'transition') {
                        transitionMutation.mutate(
                          target.variables as {
                            orderId: string;
                            stepId: string;
                            action: string;
                            body?: Record<string, unknown>;
                          },
                        );
                      } else {
                        inspectMutation.mutate(
                          target.variables as {
                            orderId: string;
                            stepId: string;
                            result: 'pass' | 'fail' | 'rework';
                            note?: string;
                          },
                        );
                      }
                    }}
                    onAction={(action, body) =>
                      submitTransition(
                        activeOrder.workOrder.scheduleTaskId,
                        step.stepId,
                        action,
                        body,
                      )
                    }
                  />
                );
              })}
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
  error,
  exceptionOpen,
  exceptionNote,
  exceptionFile,
  qcOpen,
  qcResult,
  qcNote,
  onExceptionNoteChange,
  onExceptionFileChange,
  onExceptionOpenChange,
  onQcOpenChange,
  onQcResultChange,
  onQcNoteChange,
  onSubmitException,
  onSubmitInspection,
  onRetry,
  onAction,
}: {
  step: MobileWorkbenchStep;
  pending: boolean;
  error: Error | null;
  exceptionOpen: boolean;
  exceptionNote: string;
  exceptionFile: File | null;
  qcOpen: boolean;
  qcResult: 'pass' | 'fail' | 'rework' | undefined;
  qcNote: string;
  onExceptionNoteChange: (value: string) => void;
  onExceptionFileChange: (file: File | null) => void;
  onExceptionOpenChange: (open: boolean) => void;
  onQcOpenChange: (open: boolean) => void;
  onQcResultChange: (value: 'pass' | 'fail' | 'rework') => void;
  onQcNoteChange: (value: string) => void;
  onSubmitException: () => void;
  onSubmitInspection: () => void;
  onRetry: () => void;
  onAction: (action: string, body?: Record<string, unknown>) => void;
}): React.ReactElement {
  const exception = step.resultJson?.exception as
    | Record<string, unknown>
    | undefined;
  const quality = step.resultJson?.quality as Record<string, unknown> | undefined;
  const actionMeta: Record<string, { label: string; next: string; canRun: boolean }> = {
    start: { label: '开工', next: 'in_progress', canRun: step.status === 'pending' },
    report: { label: '报工', next: 'reported', canRun: step.status === 'in_progress' },
    pause: { label: '暂停', next: 'paused', canRun: step.status === 'in_progress' },
    resume: { label: '恢复', next: 'in_progress', canRun: step.status === 'paused' },
    review: { label: '审核', next: 'reviewed', canRun: step.status === 'reported' },
    handover: { label: '交收', next: 'handed_over', canRun: step.status === 'reviewed' },
  };

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
      {step.instruction && (
        <p className="mt-2 rounded bg-white p-2 text-xs text-[hsl(218_10%_42%)]">
          <span className="font-semibold text-[hsl(220_14%_14%)]">SOP：</span>
          {step.instruction}
        </p>
      )}
      {(exception || quality) && (
        <div className="mt-2 space-y-1 rounded bg-white p-2 text-xs text-[hsl(218_10%_42%)]">
          {exception && (exception.code || exception.note) && (
            <p>
              异常：
              {exception.code ? `${String(exception.code)}: ` : ''}
              {String(exception.note ?? '已记录')}
              {exception.reportedAt ? `（${String(exception.reportedAt)}）` : ''}
            </p>
          )}
          {quality && <p>质检：{String(quality.result ?? '')}</p>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {STEP_ACTIONS.map((action) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={!actionMeta[action].canRun || pending}
            onClick={() => onAction(action)}
          >
            {actionMeta[action].label}
            {pending && <Loader2 className="ml-1 size-3 animate-spin" />}
            <span className="sr-only">{actionMeta[action].next}</span>
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onExceptionOpenChange(!exceptionOpen)}
        >
          异常上报
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            pending || !['in_progress', 'reported', 'reviewed'].includes(step.status)
          }
          onClick={() => onQcOpenChange(!qcOpen)}
        >
          质检
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-2 rounded bg-red-50 p-2 text-xs text-red-700"
        >
          <span className="min-w-0 flex-1">{error.message}</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            重试
          </Button>
        </div>
      )}
      {exceptionOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-white p-2">
          <Input
            value={exceptionNote}
            onChange={(event) => onExceptionNoteChange(event.target.value)}
            placeholder="异常说明"
            aria-label="异常说明"
            className="h-8 min-w-0 flex-1"
          />
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => onExceptionFileChange(event.target.files?.[0] ?? null)}
            className="h-8 text-xs"
            aria-label="异常照片"
          />
          {exceptionFile && (
            <span className="max-w-[140px] truncate text-[10px] text-[hsl(218_10%_42%)]">
              {exceptionFile.name}
            </span>
          )}
          <Button size="sm" onClick={onSubmitException} disabled={pending}>
            提交异常
          </Button>
        </div>
      )}
      {qcOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-white p-2">
          <label htmlFor={`qc-result-${step.stepId}`} className="text-xs">
            结果
          </label>
          <select
            id={`qc-result-${step.stepId}`}
            value={qcResult ?? ''}
            onChange={(event) =>
              onQcResultChange(
                event.target.value === ''
                  ? undefined
                  : (event.target.value as 'pass' | 'fail' | 'rework'),
              )
            }
            className="h-8 rounded border border-[hsl(220_14%_89%)] bg-white px-2 text-xs"
          >
            {QUALITY_RESULTS.map((result) => (
              <option key={result} value={result}>
                {result === 'pass' ? '合格' : result === 'fail' ? '不合格' : '返工'}
              </option>
            ))}
          </select>
          <Input
            value={qcNote}
            onChange={(event) => onQcNoteChange(event.target.value)}
            placeholder="质检备注"
            aria-label="质检备注"
            className="h-8 min-w-0 flex-1"
          />
          <Button
            size="sm"
            onClick={onSubmitInspection}
            disabled={!qcResult || pending}
          >
            提交质检
          </Button>
        </div>
      )}
    </div>
  );
}

export default MobileWorkbench;
