import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Loader2, QrCode, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  getMobileOrder,
  getWorkbench,
  inspectMobileStep,
  transitionMobileStep,
} from '../../api/mobile';
import { getAuthUser } from '../../lib/auth';
import { useOfflineWorkbench } from './useOfflineWorkbench';
// CLI-110 拆分：扫码交互与异常/质检表单分别提取为同目录 hooks（机械提取）。
import { useMobileScanner } from './useMobileScanner';
import { useMobileException } from './useMobileException';
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
import { errorDescription } from '@client/src/lib/errorContract';
import { StepCard } from './StepCard';
import { PendingQueuePanel } from './PendingQueuePanel';
import { OfflineStatusBar } from './OfflineStatusBar';
import { useNetworkState } from './useNetworkState';
import { useOfflineSettings } from './useOfflineSettings';
import { orderStatusLabel, stepStatusLabel } from './labels';

/** CLI-105：按 stepId 缓存的失败记录（kind + variables + 错误对象本体）。 */
interface FailedMutationRecord {
  kind: 'transition' | 'inspection';
  variables: unknown;
  error: Error | null;
}

const MobileWorkbench = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const personId = getAuthUser()?.userId ?? '';
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [failedMutation, setFailedMutation] = useState<
    Record<string, FailedMutationRecord | undefined>
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
        exception.clearExceptionAfterPause(step.stepId);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileOrder(activeOrderId ?? ''),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.mobileWorkbench(personId),
      });
    },
    onError: (err, variables) => {
      // CLI-105：错误对象随 stepId 缓存（不再共享全局 mutation.error，
      // 避免 A 卡片显示 B 的错误）。
      setFailedMutation((current) => ({
        ...current,
        [variables.stepId]: {
          kind: 'transition',
          variables,
          error: err instanceof Error ? err : new Error(String(err)),
        },
      }));
      toast.error('操作失败', {
        description: errorDescription(err),
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
      exception.setQcOpen((current) => ({ ...current, [stepId]: false }));
      exception.setQcNote((current) => ({ ...current, [stepId]: '' }));
    },
    onError: (err, variables) => {
      // CLI-105：同上，错误对象按 stepId 缓存。
      setFailedMutation((current) => ({
        ...current,
        [variables.stepId]: {
          kind: 'inspection',
          variables,
          error: err instanceof Error ? err : new Error(String(err)),
        },
      }));
      toast.error('质检提交失败', {
        description: errorDescription(err),
      });
    },
  });

  const activeOrder = orderQuery.data;
  const actionableSteps = useMemo(
    () => (activeOrder?.steps ?? []).filter((step) => step.status !== 'handed_over'),
    [activeOrder],
  );

  const submitTransition = useCallback(
    (orderId: string, stepId: string, action: string, body?: Record<string, unknown>) => {
      if (isOnline) {
        transitionMutation.mutate({ orderId, stepId, action, body });
        return;
      }
      void queueTransition({ orderId, stepId, action, body });
      toast.info('已加入待同步队列，联网后自动提交');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOnline, queueTransition, transitionMutation],
  );

  const submitInspection = useCallback(
    (
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOnline, queueInspection, inspectMutation],
  );

  const exception = useMobileException({
    activeOrder,
    drafts,
    isOnline,
    queueTransition,
    submitTransition,
    submitInspection,
  });

  const scanner = useMobileScanner({
    personId,
    onOrderRecognized: setActiveOrderId,
  });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">移动工作台</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">
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
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-foreground">离线数据管理</p>
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
        <p className="mt-1 text-[10px] text-muted-foreground">
          数据库损坏、升级失败或容量不足时可导出备份、修复损坏项或清空离线队列。
        </p>
      </section>

      {/* Per-user + per-device workbench settings (scan / touch / one-hand / glove) */}
      <section
        aria-label="工作台设置"
        className="rounded-lg border border-border bg-card p-3"
      >
        <p className="text-sm font-semibold text-foreground">工作台设置</p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={Boolean(settings.touchMode)}
              onChange={(event) =>
                updateSettings({ touchMode: event.target.checked })
              }
              aria-label="触控优化"
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
              aria-label="单手模式"
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
              aria-label="手套模式"
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
              className="rounded border border-border bg-card px-1"
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

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 sm:flex-row">
        <div className="relative flex-1">
          <QrCode className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={scanner.scanInput}
            onChange={(event) => scanner.setScanInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') scanner.handleScan();
            }}
            placeholder="扫码或输入工单号"
            className="min-h-12 pl-9"
            aria-label="扫码或输入工单号"
          />
        </div>
        <Button
          onClick={() => scanner.handleScan()}
          disabled={scanner.scanMutation.isPending}
          className="min-h-12 sm:w-28"
        >
          {scanner.scanMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <QrCode className="size-4" />
          )}
          扫码
        </Button>
        {scanner.supportsCamera && (
          <>
            <Button
              variant="outline"
              onClick={() => scanner.cameraInputRef.current?.click()}
              className="min-h-12 sm:w-28"
              aria-label="相机扫码"
            >
              <Camera className="size-4" />
              相机
            </Button>
            <input
              ref={scanner.cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={scanner.handleCameraCapture}
              aria-label="相机扫码上传"
            />
          </>
        )}
      </div>

      <section aria-label="我的待办工序">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">我的待办工序</h2>
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
                className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-left hover:border-[hsl(221_83%_53%)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {step.name}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
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
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-foreground">
                  {activeOrder.workOrder.title}
                </h2>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {activeOrder.workOrder.scheduleTaskId}
                </p>
              </div>
              <Badge>{orderStatusLabel(activeOrder.workOrder.status)}</Badge>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {actionableSteps.map((step) => {
                const failed = failedMutation[step.stepId];
                // CLI-105：错误对象按 stepId 隔离（failed.error），不再读全局
                // mutation.error（多 step 失败时 A 卡片会显示 B 的错误）。
                const stepError = failed?.error ?? null;
                return (
                  <StepCard
                    key={step.stepId}
                    step={step}
                    /* R2-CP1-7：pending 按 stepId 隔离（mutation.variables 为在途请求的
                       入参），A 工序提交不再导致全部工序按钮转圈。 */
                    pending={
                      (transitionMutation.isPending &&
                        transitionMutation.variables?.stepId === step.stepId) ||
                      (inspectMutation.isPending &&
                        inspectMutation.variables?.stepId === step.stepId)
                    }
                    error={stepError}
                    exceptionOpen={Boolean(exception.exceptionOpen[step.stepId])}
                    exceptionNote={exception.exceptionNote[step.stepId] ?? ''}
                    exceptionFile={exception.exceptionFile[step.stepId] ?? null}
                    qcOpen={Boolean(exception.qcOpen[step.stepId])}
                    qcResult={exception.qcResult[step.stepId]}
                    qcNote={exception.qcNote[step.stepId] ?? ''}
                    onExceptionNoteChange={(value) => {
                      exception.setExceptionNote((current) => ({
                        ...current,
                        [step.stepId]: value,
                      }));
                      exception.saveDraft(step.stepId, 'exceptionNote', value);
                    }}
                    onExceptionFileChange={(file) =>
                      exception.setExceptionFile((current) => ({
                        ...current,
                        [step.stepId]: file,
                      }))
                    }
                    onExceptionOpenChange={(open) =>
                      exception.setExceptionOpen((current) => ({
                        ...current,
                        [step.stepId]: open,
                      }))
                    }
                    onQcOpenChange={(open) =>
                      exception.setQcOpen((current) => ({ ...current, [step.stepId]: open }))
                    }
                    onQcResultChange={(value) => {
                      exception.setQcResult((current) => ({
                        ...current,
                        [step.stepId]: value,
                      }));
                      exception.saveDraft(step.stepId, 'qcResult', value);
                    }}
                    onQcNoteChange={(value) => {
                      exception.setQcNote((current) => ({ ...current, [step.stepId]: value }));
                      exception.saveDraft(step.stepId, 'qcNote', value);
                    }}
                    onSubmitException={() => void exception.handleException(step.stepId)}
                    onSubmitInspection={() => exception.handleInspect(step.stepId)}
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
                <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground md:col-span-2">
                  该工单所有工序已交收。
                </p>
              )}
            </div>
          </div>
        </section>
      )}
      {!ready && (
        <p className="text-center text-xs text-muted-foreground">
          正在加载离线存储…
        </p>
      )}
    </div>
  );
};

export default MobileWorkbench;