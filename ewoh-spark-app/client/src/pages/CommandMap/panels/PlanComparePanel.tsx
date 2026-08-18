/* Phase 4 / P4-COMPARE：Plan Compare 面板（三模式 + 权威 diff 摘要 + 聚焦）。
 *
 * 数据 = 后端 comparePlansV2（PlanCompareResult）+ active plans 下拉选择。
 * 前端只做选择与展示；change 分类/churn/reasons 全部来自后端。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActivePlans, comparePlansV2 } from '@client/src/api/scheduler';
import type { SchedulingPlanV2, PlanCompareResult, ReplanPreviewResult } from '@shared/api.interface';
import type { PlanCompareMode, PlanCompareUiState } from '../vm/planCompareVM';

interface PlanComparePanelProps {
  ui: PlanCompareUiState;
  onUiChange: (next: PlanCompareUiState) => void;
  onOpenDiff: (taskId: string) => void;
  /** M05：ReplanPreview 摘要（dry-run 候选差异；缺省不展示）。 */
  replanPreview?: ReplanPreviewResult | null;
}

const MODE_LABEL: Record<PlanCompareMode, string> = {
  BASELINE: '基线',
  CANDIDATE: '候选',
  DIFF: '差异',
};

const CHANGE_LABEL: Record<string, string> = {
  ADDED: '新增',
  REMOVED: '移除',
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

function ModeTabs({
  mode,
  onChange,
}: {
  mode: PlanCompareMode;
  onChange: (m: PlanCompareMode) => void;
}) {
  return (
    <div className="flex rounded-md border border-white/10 overflow-hidden">
      {(Object.keys(MODE_LABEL) as PlanCompareMode[]).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`flex-1 px-2 py-1 text-[10px] font-medium transition-colors ${
            mode === m
              ? 'bg-cyan-500/25 text-cyan-300'
              : 'text-white/50 hover:bg-card/5'
          }`}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

/** Plan Compare 面板：选择 baseline/candidate → 三模式 → 变更摘要 → 聚焦。 */
export function PlanComparePanel({
  ui,
  onUiChange,
  onOpenDiff,
  replanPreview,
}: PlanComparePanelProps): React.ReactElement {
  const { data: plansData } = useQuery<SchedulingPlanV2[]>({
    queryKey: ['scheduler-active-plans'],
    queryFn: getActivePlans,
  });
  const plans = plansData ?? [];

  const [result, setResult] = useState<PlanCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseline = plans.find((p) => p.planId === ui.baselinePlanId) ?? null;
  const candidate = plans.find((p) => p.planId === ui.candidatePlanId) ?? null;

  // 默认选择：最后两个方案（新方案为 candidate）。
  useEffect(() => {
    if (plans.length >= 2 && !ui.baselinePlanId && !ui.candidatePlanId) {
      onUiChange({
        ...ui,
        baselinePlanId: plans[plans.length - 2].planId,
        candidatePlanId: plans[plans.length - 1].planId,
      });
    }
  }, [plans, ui, onUiChange]);

  const runCompare = useMemo(() => {
    if (!ui.baselinePlanId || !ui.candidatePlanId || ui.baselinePlanId === ui.candidatePlanId) {
      return null;
    }
    return () => {
      setLoading(true);
      setError(null);
      comparePlansV2(ui.baselinePlanId!, ui.candidatePlanId!)
        .then(setResult)
        .catch((e: unknown) => setError((e as Error)?.message ?? String(e)))
        .finally(() => setLoading(false));
    };
  }, [ui.baselinePlanId, ui.candidatePlanId]);

  const diffByTask = result?.diffByTask ?? [];
  const focusCount = diffByTask.length;

  return (
    <div className="flex h-full w-72 flex-col gap-2 rounded-lg border border-white/10 bg-[hsl(220_14%_12%)]/95 p-2 text-white shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-white/80">方案对比</span>
        <span className="text-[9px] text-white/40">后端权威 Diff</span>
      </div>

      {/* M05：Replan Preview 摘要（dry-run readonly；Delta 来自服务端 ReplanPreviewService） */}
      {replanPreview && (
        <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-1.5">
          <div className="text-[9px] font-semibold text-cyan-300">Replan 预览（只读）</div>
          <div className="mt-1 grid grid-cols-4 gap-1 text-center text-[9px]">
            <div>
              <div className="font-bold text-white/80">{replanPreview.affectedTaskCount}</div>
              <div className="text-white/40">影响</div>
            </div>
            <div>
              <div className="font-bold text-emerald-400">{replanPreview.changedAssignmentCount}</div>
              <div className="text-white/40">变更</div>
            </div>
            <div>
              <div className="font-bold text-white/80">{replanPreview.unchangedAssignmentCount}</div>
              <div className="text-white/40">不变</div>
            </div>
            <div>
              <div className="font-bold text-white/80">{(replanPreview.churnDelta ?? 0).toFixed(2)}</div>
              <div className="text-white/40">换人</div>
            </div>
          </div>
          <div className="mt-1 text-[8px] text-white/40">
            lateness {(replanPreview.latenessDelta ?? 0).toFixed(1)} · travel{' '}
            {(replanPreview.travelDelta ?? 0).toFixed(1)} · workload{' '}
            {(replanPreview.workloadDelta ?? 0).toFixed(2)} · wait{' '}
            {(replanPreview.stationWaitDelta ?? 0).toFixed(1)} · risk{' '}
            {(replanPreview.riskDelta ?? 0).toFixed(2)}
          </div>
        </div>
      )}

      {/* 方案选择 */}
      <div className="space-y-1">
        <select
          value={ui.baselinePlanId ?? ''}
          onChange={(e) => onUiChange({ ...ui, baselinePlanId: e.target.value || null, focusedTaskId: null })}
          className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[10px] text-white/80"
        >
          <option value="">基线方案…</option>
          {plans.map((p) => (
            <option key={`b-${p.planId}`} value={p.planId}>
              {p.planName ?? p.planId} · {p.status}
            </option>
          ))}
        </select>
        <select
          value={ui.candidatePlanId ?? ''}
          onChange={(e) => onUiChange({ ...ui, candidatePlanId: e.target.value || null, focusedTaskId: null })}
          className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[10px] text-white/80"
        >
          <option value="">候选方案…</option>
          {plans.map((p) => (
            <option key={`c-${p.planId}`} value={p.planId}>
              {p.planName ?? p.planId} · {p.status}
            </option>
          ))}
        </select>
      </div>

      <ModeTabs mode={ui.mode} onChange={(m) => onUiChange({ ...ui, mode: m })} />

      <button
        type="button"
        onClick={() => runCompare?.()}
        disabled={!runCompare || loading}
        className="rounded-md bg-cyan-600/80 px-2 py-1 text-[10px] font-medium text-white hover:bg-cyan-500/80 disabled:opacity-40"
      >
        {loading ? '对比中…' : '执行对比'}
      </button>

      {error && <div className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-1 text-[9px] text-red-300">{error}</div>}

      {result && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1 text-[9px] text-white/50">
            <span className="rounded bg-card/10 px-1 py-0.5">{result.baselinePlanId.slice(-8)}</span>
            <span>→</span>
            <span className="rounded bg-card/10 px-1 py-0.5">{result.candidatePlanId.slice(-8)}</span>
          </div>
          {/* 变更摘要 */}
          <div className="grid grid-cols-3 gap-1 text-center">
            <div className="rounded border border-emerald-500/30 bg-emerald-500/10 py-1">
              <div className="text-[11px] font-bold text-emerald-400">{result.added.length}</div>
              <div className="text-[8px] text-white/40">新增</div>
            </div>
            <div className="rounded border border-red-500/30 bg-red-500/10 py-1">
              <div className="text-[11px] font-bold text-red-400">{result.removed.length}</div>
              <div className="text-[8px] text-white/40">移除</div>
            </div>
            <div className="rounded border border-amber-500/30 bg-amber-500/10 py-1">
              <div className="text-[11px] font-bold text-amber-400">{focusCount}</div>
              <div className="text-[8px] text-white/40">变更</div>
            </div>
          </div>
          <div className="text-[9px] text-white/50">
            换人 {result.churn} ·{' '}
            {Object.entries(result.changeTypeCounts)
              .map(([k, v]) => `${CHANGE_LABEL[k] ?? k} ${v}`)
              .join(' · ')}
          </div>
          {/* diff 任务列表 */}
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {diffByTask.map((d) => (
              <button
                key={d.taskId}
                type="button"
                onClick={() => onOpenDiff(d.taskId)}
                className={`flex w-full items-center justify-between rounded border px-1.5 py-1 text-left ${
                  ui.focusedTaskId === d.taskId
                    ? 'border-cyan-500/40 bg-cyan-500/10'
                    : 'border-white/10 bg-card/5 hover:bg-card/10'
                }`}
              >
                <span className="truncate text-[10px] text-white/80">{d.taskId}</span>
                <span className="ml-1 flex flex-wrap gap-0.5">
                  {d.changeTypes.slice(0, 3).map((ct) => (
                    <span key={ct} className="rounded bg-card/10 px-1 text-[7.5px] text-white/60">
                      {CHANGE_LABEL[ct] ?? ct}
                    </span>
                  ))}
                </span>
              </button>
            ))}
            {diffByTask.length === 0 && (
              <div className="py-2 text-center text-[9px] text-white/40">无任务变更（方案相同）</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanComparePanel;
