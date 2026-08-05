import { Loader2 } from 'lucide-react';
import type { MobileWorkbenchStep } from '../../api/mobile';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import { stepStatusLabel } from './labels';

export const STEP_ACTIONS = [
  'start',
  'report',
  'pause',
  'resume',
  'review',
  'handover',
] as const;
export const QUALITY_RESULTS = ['pass', 'fail', 'rework'] as const;

export interface StepCardProps {
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
}

export function StepCard(props: StepCardProps): React.ReactElement {
  const {
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
  } = props;
  const exception = step.resultJson?.exception as Record<string, unknown> | undefined;
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
            className="min-h-12 px-4 text-sm"
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
          className="min-h-12 px-4 text-sm"
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
          className="min-h-12 px-4 text-sm"
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
            className="min-h-12 min-w-0 flex-1"
          />
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => onExceptionFileChange(event.target.files?.[0] ?? null)}
            className="min-h-12 text-xs"
            aria-label="异常照片"
          />
          {exceptionFile && (
            <span className="max-w-[140px] truncate text-[10px] text-[hsl(218_10%_42%)]">
              {exceptionFile.name}
            </span>
          )}
          <Button size="sm" onClick={onSubmitException} disabled={pending} className="min-h-12">
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
            className="min-h-12 rounded border border-[hsl(220_14%_89%)] bg-white px-2 text-xs"
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
            className="min-h-12 min-w-0 flex-1"
          />
          <Button
            size="sm"
            onClick={onSubmitInspection}
            disabled={!qcResult || pending}
            className="min-h-12"
          >
            提交质检
          </Button>
        </div>
      )}
    </div>
  );
}