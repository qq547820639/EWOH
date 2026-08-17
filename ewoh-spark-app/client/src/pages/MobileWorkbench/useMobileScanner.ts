/* CLI-110 拆分：MobileWorkbench 的扫码交互 hook（机械提取，行为不变）。
 *
 * 持有：扫码输入 state、scanWorkbench mutation、扫码枪全局监听、
 * 相机条码识别。识别到工单/工序后经 onOrderRecognized 上抛（外壳
 * 持有 activeOrderId 状态，所有权不变）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { scanWorkbench } from '../../api/mobile';
import {
  createScannerListener,
  detectBarcodeFromFile,
  playScanFeedback,
  supportsCameraCapture,
} from '../../lib/scanner';
import { queryKeys } from '../../hooks/queryKeys';
import { scanTypeLabel } from './labels';

export function useMobileScanner({
  personId,
  onOrderRecognized,
}: {
  personId: string;
  onOrderRecognized: (scheduleTaskId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [scanInput, setScanInput] = useState('');

  const scanMutation = useMutation({
    mutationFn: (value: string) => scanWorkbench(value),
    onSuccess: (result) => {
      if ('scanType' in result && result.scanType === 'step') {
        onOrderRecognized(result.step.scheduleTaskId);
        toast.success(`已识别工序：${result.step.stepId}`);
      } else if ('scanType' in result) {
        toast.info(`${scanTypeLabel(result.scanType)} ${result.reference} 已识别`);
      } else {
        onOrderRecognized(result.workOrder.scheduleTaskId);
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

  return {
    scanInput,
    setScanInput,
    scanMutation,
    handleScan,
    cameraInputRef,
    handleCameraCapture,
    supportsCamera: supportsCameraCapture(),
  };
}
