/* Phase 4 / P4-PREVIEW：Conflict Preview 处置工作台。
 *
 * 流程：Conflict → Root Cause → Affected → Suggested Action → Preview → Diff → Apply。
 * Preview 调用后端 POST /conflicts/:id/actions/preview（read-only，不改生产状态）；
 * 地图 Diff 复用 PlanCompareLayer（通过 onPreviewDiff 上传 compare VM）。
 * 前端不判断业务动作——suggested action / diff / reasons 全部来自后端。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Play, RefreshCw, X, ArrowRight } from 'lucide-react';
import { previewConflictAction } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
import type { SchedulingConflict } from '@shared/api.interface';
import type { ConflictPreviewResult } from '@shared/api.interface';
import type { PlanCompareMode } from '../vm/planCompareVM';
import { previewSummary, resolvePreviewAction } from './conflict-preview-logic';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';

interface ConflictPreviewPanelProps {
  conflict: SchedulingConflict;
  onClose: () => void;
  /** 预览 diff 上传给地图（复用 PlanCompareLayer 渲染）；null = 清除。 */
  onPreviewDiff: (preview: ConflictPreviewResult | null) => void;
  /** 正式 Apply：由父组件触发真实 replan（冲突 → 新方案）。 */
  onApply: (conflict: SchedulingConflict, action?: string) => void;
}

const MODE_LABEL: Record<PlanCompareMode, string> = {
  BASELINE: '基线',
  CANDIDATE: '候选',
  DIFF: '差异',
};

const CHANGE_LABEL: Record<string, string> = {
  ADDED: '新增',
  REMOVED: '移除',
  PERSON_CHANGED: '人员',
  DEVICE_CHANGED: '设备',
  STATION_CHANGED: '工位',
  TIME_CHANGED: '时间',
  ROUTE_CHANGED: '路线',
  ETA_CHANGED: 'ETA',
  DISTANCE_CHANGED: '距离',
  RISK_CHANGED: '风险',
};

/** Conflict Preview 工作台（read-only preview → diff → human apply）。 */
export function ConflictPreviewPanel({
  conflict,
  onClose,
  onPreviewDiff,
  onApply,
}: ConflictPreviewPanelProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ConflictPreviewResult | null>(null);
  const [mode, setMode] = useState<PlanCompareMode>('DIFF');

  // Task 12/12.3：焦点管理（镜像 Shell 帮助对话框模式：打开存焦点 → 关闭恢复 + Escape 关闭）。
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, []);

  const previewMutation = useMutation({
    mutationFn: () => previewConflictAction(conflict.conflictId, resolvePreviewAction(conflict) ? { action: resolvePreviewAction(conflict) } : {}),
    onSuccess: (data) => {
      setPreview(data);
      onPreviewDiff(data);
      queryClient.invalidateQueries({ queryKey: queryKeys.schedulerConflicts() });
    },
    onError: (e) => {
      toast.error(`预览失败：${e instanceof Error ? e.message : '未知错误'}`);
    },
  });

  const diff = preview?.diff ?? null;
  const diffEntries = diff?.diffByTask ?? [];
  const changeTypeCounts = diff?.changeTypeCounts ?? {};

  return (
    <div
      className="flex h-full w-[380px] flex-col gap-2 rounded-lg border border-white/10 bg-[hsl(220_14%_12%)]/95 p-2 text-white shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-label="冲突处置工作台"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-white/85">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          冲突处置工作台
        </span>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={UI_ARIA_LABELS.closeConflictPreview}
          className="rounded px-1.5 text-[10px] text-white/50 hover:bg-white/10"
        >
          ✕
        </button>
      </div>

      {/* Root Cause */}
      <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
        <div className="text-[9px] text-white/50">根因</div>
        <div className="mt-0.5 text-[10.5px] text-white/85">{conflict.message}</div>
        <div className="mt-1 flex flex-wrap gap-1 text-[8.5px]">
          <span className="rounded bg-white/10 px-1 py-0.5 text-white/60">{conflict.type}</span>
          <span className="rounded bg-white/10 px-1 py-0.5 text-white/60">severity={conflict.severity}</span>
          <span className="rounded bg-white/10 px-1 py-0.5 text-white/60">{conflict.conflictId}</span>
        </div>
      </div>

      {/* Affected */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded border border-white/10 bg-black/20 px-2 py-1">
          <div className="text-[9px] text-white/50">受影响任务</div>
          <div className="mt-0.5 max-h-16 space-y-0.5 overflow-y-auto text-[9.5px] text-white/75">
            {conflict.taskIds.length > 0
              ? conflict.taskIds.map((t) => <div key={t} className="truncate">· {t}</div>)
              : <div className="text-white/35">—</div>}
          </div>
        </div>
        <div className="rounded border border-white/10 bg-black/20 px-2 py-1">
          <div className="text-[9px] text-white/50">受影响资源</div>
          <div className="mt-0.5 space-y-0.5 text-[9.5px] text-white/75">
            {conflict.resourceId
              ? <div className="truncate">· {conflict.resourceId} ({String(conflict.resourceType ?? '?')})</div>
              : <div className="text-white/35">—</div>}
          </div>
        </div>
      </div>

      {/* Suggested Action（后端提供） */}
      <div className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5">
        <div className="text-[9px] text-emerald-400/80">建议处置（后端）</div>
        <div className="mt-0.5 text-[10px] text-emerald-200/90">{conflict.resolution ?? '—'}</div>
      </div>

      {/* Preview Button */}
      <button
        type="button"
        onClick={() => previewMutation.mutate()}
        disabled={previewMutation.isPending}
        className="flex items-center justify-center gap-1.5 rounded-md bg-cyan-600/80 px-2 py-1.5 text-[10px] font-medium text-white hover:bg-cyan-500/80 disabled:opacity-40"
      >
        {previewMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
        预览重排（只读，不改变生产）
      </button>

      {/* Preview Result */}
      {preview && (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          {/* Mode Tabs */}
          <div className="flex rounded-md border border-white/10 overflow-hidden">
            {(Object.keys(MODE_LABEL) as PlanCompareMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 px-2 py-1 text-[9.5px] font-medium ${
                  mode === m ? 'bg-cyan-500/25 text-cyan-300' : 'text-white/50 hover:bg-white/5'
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>

          {/* Summary */}
          <div className="flex flex-wrap items-center gap-1 text-[9px] text-white/50">
            <span className="rounded bg-white/10 px-1 py-0.5">{preview.baselinePlanId?.slice(-8) ?? '—'}</span>
            <ArrowRight className="w-2.5 h-2.5" />
            <span className="rounded bg-white/10 px-1 py-0.5">{preview.candidatePlanId?.slice(-8) ?? '—'}</span>
            {diff && (
              <span className="ml-auto text-white/60">
                换人 {diff.churn} · 变更 {diff.diffByTask.length} · +{diff.added.length} -{diff.removed.length}
              </span>
            )}
          </div>
          {Object.keys(changeTypeCounts).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(changeTypeCounts).map(([k, v]) => (
                <span key={k} className="rounded bg-white/10 px-1 text-[8px] text-white/60">
                  {CHANGE_LABEL[k] ?? k} {String(v)}
                </span>
              ))}
            </div>
          )}

          {/* Diff list */}
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {diffEntries.length > 0 ? (
              diffEntries.map((d) => (
                <div key={d.taskId} className="rounded border border-white/10 bg-white/5 px-1.5 py-1">
                  <div className="flex items-center justify-between">
                    <span className="truncate text-[9.5px] text-white/80">{d.taskId}</span>
                    <span className="ml-1 flex flex-wrap gap-0.5">
                      {d.changeTypes.slice(0, 3).map((ct) => (
                        <span key={ct} className="rounded bg-amber-500/15 px-1 text-[7.5px] text-amber-300">
                          {CHANGE_LABEL[ct] ?? ct}
                        </span>
                      ))}
                    </span>
                  </div>
                  {(d.before || d.after) && (
                    <div className="mt-0.5 grid grid-cols-2 gap-1 text-[8.5px] text-white/55">
                      <div>
                        <span className="text-red-400/70">前 </span>
                        {d.before?.personId ?? '—'} → {d.before?.stationId ?? '—'}
                        {d.before?.etaSeconds != null ? ` · ${d.before.etaSeconds}s` : ''}
                      </div>
                      <div>
                        <span className="text-emerald-400/70">后 </span>
                        {d.after?.personId ?? '—'} → {d.after?.stationId ?? '—'}
                        {d.after?.etaSeconds != null ? ` · ${d.after.etaSeconds}s` : ''}
                      </div>
                    </div>
                  )}
                  {d.reasons.length > 0 && (
                    <div className="mt-0.5 text-[8.5px] text-white/45">
                      {d.reasons.map((r, i) => (
                        <div key={i}>· {r}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="py-3 text-center text-[9px] text-white/40">无任务变更</div>
            )}
          </div>

          {/* Remaining conflicts */}
          {preview.remainingConflicts.length > 0 && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 px-1.5 py-1">
              <div className="text-[8.5px] text-amber-400/80">剩余冲突 {preview.remainingConflicts.length}</div>
              {preview.remainingConflicts.slice(0, 3).map((rc) => (
                <div key={rc.conflictId} className="truncate text-[8.5px] text-white/50">· {rc.message}</div>
              ))}
            </div>
          )}

          {/* Apply */}
          <button
            type="button"
            onClick={() => onApply(conflict, resolvePreviewAction(conflict))}
            className="flex items-center justify-center gap-1.5 rounded-md bg-emerald-600/80 px-2 py-1.5 text-[10px] font-medium text-white hover:bg-emerald-500/80"
          >
            <RefreshCw className="w-3 h-3" />
            确认并应用（触发正式重排）
          </button>
        </div>
      )}
    </div>
  );
}

export default ConflictPreviewPanel;
