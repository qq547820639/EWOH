import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Loader2, QrCode, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  getMobileOrder,
  getWorkbench,
  inspectMobileStep,
  scanWorkbench,
  transitionMobileStep,
} from '../../api/mobile';
import { uploadFile } from '../../api/files';
import { getAuthUser } from '../../lib/auth';
import { useOfflineWorkbench } from './useOfflineWorkbench';
import {
  createScannerListener,
  detectBarcodeFromFile,
  playScanFeedback,
  supportsCameraCapture,
} from '../../lib/scanner';
import { queryKeys } from '../../hooks/queryKeys';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@client/src/components/ui/alert-dialog';
import QueryState from '../../components/QueryState';
import { buildExceptionBody } from './exceptionPayload';
import { StepCard } from './StepCard';
import { PendingQueuePanel } from './PendingQueuePanel';
import { OfflineStatusBar } from './OfflineStatusBar';
import { useNetworkState } from './useNetworkState';
import { useOfflineSettings } from './useOfflineSettings';
import { orderStatusLabel, scanTypeLabel, stepStatusLabel } from './labels';

const MobileWorkbench = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const personId = getAuthUser()?.userId ?? '';
  const [scanInput, setScanInput] = useState('');
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
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

  const onSynced = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.mobileWorkbench(personId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.mobileOrder(activeOrderId ?? ''),
    });
  }, [queryClient, personId, activeOrderId]);

  const {
    ready,
    isOnline,
    syncing,
    authPaused,
    pendingActions,
    pendingCount,
    lastSyncAt,
    drafts,
    queueTransition,
    queueInspection,
    retryPending,
    batchRetry,
    discardPending,
    resolveConflict,
    exportOffline,
    recoverOffline,
    clearOfflineData,
  } = useOfflineWorkbench(personId, { onSynced });

  const network = useNetworkState({
    isOnline,
    lastSyncAt,
    pendingStatuses: pendingActions.map((item) => item.status),
  });

  const { settings, update: updateSettings } = useOfflineSettings(personId);

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
    mutationFn: (value: string) => scanWorkbench(value),
    onSuccess: (result) => {
      if ('scanType' in result && result.scanType === 'step') {
        setActiveOrderId(result.step.scheduleTaskId);
        toast.success(`已识别工序：${result.step.stepId}`);
      } else if ('scanType' in result) {
        toast.info(`${scanTypeLabel(result.scanType)} ${result.reference} 已识别`);
      } else {
        setActiveOrderId(result.workOrder.scheduleTaskId);
        toast.success(`已扫码：${result.workOrder.title}`);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
    },
    onError: (err) => {
      playScanFeedback('fail');
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

  // ---- Draft auto-save (steps 5) ----
  const saveDraft = useCallback(
    (stepId: string, field: string, value: unknown) => {
      const orderId = activeOrder?.workOrder.scheduleTaskId;
      if (!orderId || !drafts) {
        return;
      }
      void drafts.save({ orderId, stepId, field }, value);
    },
    [activeOrder, drafts],
  );

  const restoredStepsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!drafts || !activeOrder) {
      return undefined;
    }
    const orderId = activeOrder.workOrder.scheduleTaskId;
    let cancelled = false;
    const restore = async () => {
      for (const step of activeOrder.steps) {
        if (restoredStepsRef.current.has(step.stepId)) {
          continue;
        }
        const [note, noteVal, resultVal] = await Promise.all([
          drafts.get({ orderId, stepId: step.stepId, field: 'exceptionNote' }),
          drafts.get({ orderId, stepId: step.stepId, field: 'qcNote' }),
          drafts.get({ orderId, stepId: step.stepId, field: 'qcResult' }),
        ]);
        if (cancelled) {
          return;
        }
        restoredStepsRef.current.add(step.stepId);
        if (typeof note === 'string' && note) {
          setExceptionNote((current) => ({ ...current, [step.stepId]: note }));
        }
        if (typeof noteVal === 'string' && noteVal) {
          setQcNote((current) => ({ ...current, [step.stepId]: noteVal }));
        }
        if (resultVal === 'pass' || resultVal === 'fail' || resultVal === 'rework') {
          setQcResult((current) => ({ ...current, [step.stepId]: resultVal }));
        }
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [activeOrder, drafts]);

  // ---- Scanner (steps 7) ----
  const lastScanRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });
  const handleScan = useCallback(
    (raw?: string) => {
      const value = (raw ?? scanInput).trim();
      if (!value) {
        toast.error('请输入或扫码工单号');
        return;
      }
      const now = Date.now();
      const kind =
        lastScanRef.current.value === value && now - lastScanRef.current.at < 1500
          ? 'duplicate'
          : 'success';
      lastScanRef.current = { value, at: now };
      playScanFeedback(kind);
      setScanInput(value);
      scanMutation.mutate(value);
    },
    [scanInput, scanMutation],
  );

  const handleScanRef = useRef<(value: string) => void>(() => {});
  handleScanRef.current = handleScan;

  useEffect(() => {
    const listener = createScannerListener({
      onScan: (value) => handleScanRef.current(value),
      onError: (message) => toast.error(message),
    });
    const onKeyDown = (event: KeyboardEvent) => listener.handleKeyDown(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const handleCameraCapture = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const value = await detectBarcodeFromFile(file);
      if (value) {
        playScanFeedback('success');
        handleScan(value);
      } else {
        playScanFeedback('fail');
        toast.error('未识别到条码，请尝试手动输入或使用扫码枪');
      }
    } catch (error) {
      playScanFeedback('fail');
      toast.error('条码识别不可用', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
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
    void queueTransition({ orderId, stepId, action, body });
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
    void queueInspection({ orderId, stepId, result, note });
    toast.info('质检已加入待同步队列');
  };

  const handleException = async (stepId: string) => {
    const note = exceptionNote[stepId]?.trim();
    if (!note) {
      toast.error('请填写异常说明');
      return;
    }
    const file = exceptionFile[stepId] ?? null;
    const orderId = activeOrder!.workOrder.scheduleTaskId;
    if (!isOnline) {
      try {
        await queueTransition({
          orderId,
          stepId,
          action: 'pause',
          body: buildExceptionBody(note),
          ...(file
            ? {
                attachment: {
                  name: file.name,
                  contentType: file.type || 'image/jpeg',
                  data: file,
                },
              }
            : {}),
        });
        toast.info(file ? '异常及照片已加入待同步队列' : '异常已加入待同步队列');
      } catch (error) {
        toast.error('离线照片处理失败', {
          description: error instanceof Error ? error.message : undefined,
        });
      }
      return;
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
    submitTransition(orderId, stepId, 'pause', body);
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
        </div>
      </header>

      {/* Offline status center (online / offline / weak / stale / syncing / failed) */}
      <OfflineStatusBar
        network={network}
        pendingCount={pendingCount}
        lastSyncAt={lastSyncAt}
        syncing={syncing}
      />

      {authPaused && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <span className="min-w-0 flex-1">
            登录已失效，离线同步已暂停。请重新登录后继续同步，未同步的操作会安全保留。
          </span>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            重新登录
          </Button>
        </div>
      )}

      {!isOnline && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
        >
          当前处于离线状态，操作会加入待同步队列，联网后自动提交。
        </div>
      )}

      {/* Offline data management (corruption / upgrade / capacity entry points) */}
      <section
        aria-label="离线数据管理"
        className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-[hsl(220_14%_14%)]">离线数据管理</p>
          <Button size="sm" variant="outline" onClick={() => void exportOffline()}>
            导出备份
          </Button>
          <Button size="sm" variant="outline" onClick={() => void recoverOffline()}>
            修复数据
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-700"
            onClick={() => setConfirmClearOpen(true)}
          >
            清空离线数据
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-[hsl(218_10%_42%)]">
          数据库损坏、升级失败或容量不足时可导出备份、修复损坏项或清空离线队列。
        </p>
      </section>

      {/* Per-user + per-device workbench settings (scan / touch / one-hand / glove) */}
      <section
        aria-label="工作台设置"
        className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3"
      >
        <p className="text-sm font-semibold text-[hsl(220_14%_14%)]">工作台设置</p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-[hsl(218_10%_42%)]">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={Boolean(settings.touchMode)}
              onChange={(event) =>
                updateSettings({ touchMode: event.target.checked })
              }
            />
            触控优化
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={Boolean(settings.oneHandMode)}
              onChange={(event) =>
                updateSettings({ oneHandMode: event.target.checked })
              }
            />
            单手模式
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={Boolean(settings.gloveMode)}
              onChange={(event) =>
                updateSettings({ gloveMode: event.target.checked })
              }
            />
            手套模式
          </label>
          <label className="flex items-center gap-1">
            扫码
            <select
              value={settings.scanMode ?? 'manual'}
              onChange={(event) =>
                updateSettings({
                  scanMode: event.target.value as
                    | 'scanner'
                    | 'camera'
                    | 'manual',
                })
              }
              className="rounded border border-[hsl(220_14%_89%)] bg-white px-1"
            >
              <option value="manual">手动输入</option>
              <option value="scanner">扫码枪</option>
              <option value="camera">相机</option>
            </select>
          </label>
        </div>
      </section>

      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空离线数据</AlertDialogTitle>
            <AlertDialogDescription>
              此操作将清空全部待同步操作与离线附件，且不可撤销。请先导出备份再继续。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmClearOpen(false);
                void clearOfflineData();
              }}
            >
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {pendingActions.length > 0 && (
        <PendingQueuePanel
          items={pendingActions}
          onRetry={(id) => retryPending(id)}
          onBatchRetry={(ids) => batchRetry(ids)}
          onDiscard={(id) => discardPending(id)}
          onResolve={(id, choice) => resolveConflict(id, choice)}
        />
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
            className="min-h-12 pl-9"
            aria-label="扫码或输入工单号"
          />
        </div>
        <Button
          onClick={() => handleScan()}
          disabled={scanMutation.isPending}
          className="min-h-12 sm:w-28"
        >
          {scanMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <QrCode className="size-4" />
          )}
          扫码
        </Button>
        {supportsCameraCapture() && (
          <>
            <Button
              variant="outline"
              onClick={() => cameraInputRef.current?.click()}
              className="min-h-12 sm:w-28"
              aria-label="相机扫码"
            >
              <Camera className="size-4" />
              相机
            </Button>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleCameraCapture}
              aria-label="相机扫码上传"
            />
          </>
        )}
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
          error={workbenchQuery.error}
          errorMessage={
            workbenchQuery.error instanceof Error
              ? workbenchQuery.error.message
              : '加载失败'
          }
          backHref="/command-center"
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
                className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3 text-left hover:border-[hsl(221_83%_53%)]"
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
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
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
                    onExceptionNoteChange={(value) => {
                      setExceptionNote((current) => ({ ...current, [step.stepId]: value }));
                      saveDraft(step.stepId, 'exceptionNote', value);
                    }}
                    onExceptionFileChange={(file) =>
                      setExceptionFile((current) => ({ ...current, [step.stepId]: file }))
                    }
                    onExceptionOpenChange={(open) =>
                      setExceptionOpen((current) => ({ ...current, [step.stepId]: open }))
                    }
                    onQcOpenChange={(open) =>
                      setQcOpen((current) => ({ ...current, [step.stepId]: open }))
                    }
                    onQcResultChange={(value) => {
                      setQcResult((current) => ({ ...current, [step.stepId]: value }));
                      saveDraft(step.stepId, 'qcResult', value);
                    }}
                    onQcNoteChange={(value) => {
                      setQcNote((current) => ({ ...current, [step.stepId]: value }));
                      saveDraft(step.stepId, 'qcNote', value);
                    }}
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
                <p className="rounded-lg bg-[hsl(220_14%_96%)] p-3 text-sm text-[hsl(218_10%_42%)] md:col-span-2">
                  该工单所有工序已交收。
                </p>
              )}
            </div>
          </div>
        </section>
      )}
      {!ready && (
        <p className="text-center text-xs text-[hsl(218_10%_42%)]">
          正在加载离线存储…
        </p>
      )}
    </div>
  );
};

export default MobileWorkbench;