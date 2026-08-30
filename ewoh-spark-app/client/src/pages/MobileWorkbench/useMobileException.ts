/* CLI-110 拆分：MobileWorkbench 的异常/质检表单 hook（机械提取，行为不变）。
 *
 * 持有：exceptionOpen/exceptionNote/exceptionFile 与 qcOpen/qcResult/qcNote
 * 的按 stepId 分桶状态、IndexedDB 草稿保存/恢复、异常提交（在线走
 * uploadFile+submitTransition，离线走 queueTransition）与质检提交。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFile } from '../../api/files';
import type { DraftStore } from '../../lib/draftStore';
import { buildExceptionBody } from './exceptionPayload';
import type { QueueAttachment } from './useOfflineWorkbench';
import { errorDescription } from '../../lib/errorContract';

interface MobileOrderLike {
  workOrder: { scheduleTaskId: string };
  steps: Array<{ stepId: string }>;
}

export function useMobileException({
  activeOrder,
  drafts,
  isOnline,
  queueTransition,
  submitTransition,
  submitInspection,
}: {
  activeOrder: MobileOrderLike | null | undefined;
  drafts: DraftStore | null | undefined;
  isOnline: boolean;
  queueTransition: (input: {
    orderId: string;
    stepId: string;
    action: string;
    body?: Record<string, unknown>;
    attachment?: QueueAttachment;
  }) => Promise<void>;
  submitTransition: (
    orderId: string,
    stepId: string,
    action: string,
    body?: Record<string, unknown>,
  ) => void;
  submitInspection: (
    orderId: string,
    stepId: string,
    result: 'pass' | 'fail' | 'rework',
    note?: string,
  ) => void;
}) {
  const [exceptionOpen, setExceptionOpen] = useState<Record<string, boolean>>({});
  const [exceptionNote, setExceptionNote] = useState<Record<string, string>>({});
  const [exceptionFile, setExceptionFile] = useState<Record<string, File | null>>({});
  const [qcOpen, setQcOpen] = useState<Record<string, boolean>>({});
  const [qcResult, setQcResult] = useState<
    Record<string, 'pass' | 'fail' | 'rework' | undefined>
  >({});
  const [qcNote, setQcNote] = useState<Record<string, string>>({});

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

  // ---- Draft restore（工序首次可见时从 IndexedDB 恢复草稿，一次性） ----
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

  /** pause 成功后清空该 step 的异常表单（由外壳 transition onSuccess 调用）。 */
  const clearExceptionAfterPause = useCallback((stepId: string) => {
    setExceptionNote((current) => ({ ...current, [stepId]: '' }));
    setExceptionOpen((current) => ({ ...current, [stepId]: false }));
  }, []);

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
          description: errorDescription(error),
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
          description: errorDescription(error),
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

  return {
    exceptionOpen,
    exceptionNote,
    exceptionFile,
    qcOpen,
    qcResult,
    qcNote,
    setExceptionOpen,
    setExceptionNote,
    setExceptionFile,
    setQcOpen,
    setQcResult,
    setQcNote,
    saveDraft,
    clearExceptionAfterPause,
    handleException,
    handleInspect,
  };
}
