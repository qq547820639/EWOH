/* Phase 4 / P4-COMPARE：Plan Diff 详情抽屉。
 *
 * 展示后端 PlanAssignmentDiff：Before / After / Change Types / Reasons。
 * Reasons 来自后端 PlanCompare/DecisionTrace 解释，前端不猜测。
 */
import React, { useEffect, useRef } from 'react';
import type { PlanAssignmentDiff } from '@shared/api.interface';
import type { CompareMapEntry } from '../vm/planCompareVM';
import { UI_ARIA_LABELS } from '@client/src/lib/a11y';

interface PlanDiffDrawerProps {
  entry: CompareMapEntry | null;
  diff: PlanAssignmentDiff | null;
  onClose: () => void;
}

const CHANGE_LABEL: Record<string, string> = {
  ADDED: '新增任务',
  REMOVED: '移除任务',
  PERSON_CHANGED: '人员变更',
  DEVICE_CHANGED: '设备变更',
  STATION_CHANGED: '工位变更',
  TIME_CHANGED: '时间变更',
  ROUTE_CHANGED: '路线变更',
  ETA_CHANGED: 'ETA变更',
  DISTANCE_CHANGED: '距离变更',
  WORKLOAD_CHANGED: '负荷变更',
  LATENESS_CHANGED: '迟到变更',
  RISK_CHANGED: '风险变更',
  CONFLICT_CHANGED: '冲突变更',
  CHURN: '换人',
};

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}

function SnapshotBlock({
  title,
  snap,
}: {
  title: string;
  snap: CompareMapEntry['before'] | null;
}) {
  if (!snap) {
    return (
      <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
        <div className="text-[9px] text-white/50">{title}</div>
        <div className="text-[10px] text-white/40">—</div>
      </div>
    );
  }
  return (
    <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
      <div className={`text-[9px] ${title === 'Before' ? 'text-red-400/70' : 'text-emerald-400/70'}`}>
        {title}
      </div>
      <div className="mt-0.5 space-y-0.5 text-[10px] text-white/75">
        <div>人员: {snap.personId ?? '—'}</div>
        <div>设备: {snap.deviceId ?? '—'}</div>
        <div>工位: {snap.stationId ?? '—'}</div>
        <div>开始: {fmtTime(snap.plannedStart)}</div>
        {snap.etaSeconds != null && <div>ETA: {snap.etaSeconds.toFixed(0)}s</div>}
        {snap.distanceMeters != null && <div>距离: {snap.distanceMeters.toFixed(0)}m</div>}
        {snap.riskLevel != null && <div>风险: {snap.riskLevel}</div>}
      </div>
    </div>
  );
}

/** Plan Diff 详情抽屉（Before/After/Change Types/Reasons；全部后端事实）。 */
export function PlanDiffDrawer({
  entry,
  diff,
  onClose,
}: PlanDiffDrawerProps): React.ReactElement | null {
  // Task 12/12.3：焦点管理（镜像 Shell 帮助对话框模式：打开存焦点 → 关闭恢复 + Escape 关闭）。
  // hooks 必须在条件 return 之前无条件调用。
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

  if (!entry) return null;
  const changeTypes = entry.changeTypes ?? diff?.changeTypes ?? [];
  const reasons = entry.reasons ?? diff?.reasons ?? [];

  return (
    <div
      className="absolute bottom-2 left-2 z-40 w-72 rounded-lg border border-white/10 bg-[hsl(220_14%_12%)]/95 p-2 text-white shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-label="变更详情"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-white/85">变更详情</span>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={UI_ARIA_LABELS.closePlanDiff}
          className="rounded px-1.5 text-[10px] text-white/50 hover:bg-card/10"
        >
          ✕
        </button>
      </div>
      <div className="mt-1 text-[10px] text-white/70">{entry.taskId}</div>

      {/* Change Types */}
      {changeTypes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {changeTypes.map((ct) => (
            <span
              key={ct}
              className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[8px] text-amber-300"
            >
              {CHANGE_LABEL[ct] ?? ct}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <SnapshotBlock title="Before" snap={entry.before} />
        <SnapshotBlock title="After" snap={entry.after} />
      </div>

      {/* Reasons（后端解释，CLI-033：内容作稳定 key） */}
      {reasons.length > 0 && (
        <div className="mt-2">
          <div className="text-[9px] text-white/50">原因</div>
          <div className="mt-0.5 space-y-0.5">
            {Array.from(new Set(reasons)).map((r) => (
              <div key={`reason-${r}`} className="text-[9.5px] text-white/60">
                · {r}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanDiffDrawer;
