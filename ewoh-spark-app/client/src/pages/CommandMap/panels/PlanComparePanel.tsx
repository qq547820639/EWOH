/* Phase 4 / P4-COMPARE：Plan Compare 面板（三模式 + 权威 diff 摘要 + 聚焦）。
 *
 * 数据 = 后端 comparePlansV2（PlanCompareResult）+ active plans 下拉选择。
 * 前端只做选择与展示；change 分类/churn/reasons 全部来自后端。
 *
 * UR7（2026-09-13 对抗审查）：取数源与 CommandMapShell 统一——同一 queryKey
 * （['scheduler-compare', baseline, candidate]）。此前面板自带一份手动 fetch，
 * 与 shell 自动查询（地图 PlanCompareLayer / PlanDiffDrawer 消费）各自请求：
 * 打开对比后地图已画出 diff 而面板为空，点击后面板取自第二个时点的请求，
 * 方案被 SSE 更新过时面板摘要与地图叠加层不一致。改为消费同一 React Query
 * 缓存后单一取数源；「执行对比」= refetch（需要刷新时的显式动作）。
 */
import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActivePlans, comparePlansV2 } from '@client/src/api/scheduler';
import { queryKeys } from '@client/src/hooks/queryKeys';
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
    // CLI-715：缓存键按当前登录组织分片（还原此处的无 org 原始键写法）。
    queryKey: queryKeys.schedulerActivePlans,
    queryFn: getActivePlans,
  });
  const plans = plansData ?? [];

  const baseline = plans.find((p) => p.planId === ui.baselinePlanId) ?? null;
  const candidate = plans.find((p) => p.planId === ui.candidatePlanId) ?? null;

  // UR7：与 CommandMapShell.compareResultQuery 同 key 同语义——单一取数源。
  // 非法配对（缺 id / baseline === candidate）返回 null，与 shell 的 queryFn 一致。
  const pairValid =
    !!ui.baselinePlanId && !!ui.candidatePlanId && ui.baselinePlanId !== ui.candidatePlanId;
  const compareQuery = useQuery<PlanCompareResult | null>({
    queryKey: ['scheduler-compare', ui.baselinePlanId, ui.candidatePlanId],
    queryFn: async () => {
      if (!pairValid || !ui.baselinePlanId || !ui.candidatePlanId) return null;
      return comparePlansV2(ui.baselinePlanId, ui.candidatePlanId);
    },
    enabled: pairValid,
  });
  const result = compareQuery.data ?? null;
  // isFetching 覆盖 shell 自动取数与本面板的手动 refetch（同一缓存的在途状态）。
  const loading = compareQuery.isFetching;
  const error = compareQuery.isError
    ? (compareQuery.error instanceof Error
        ? compareQuery.error.message
        : String(compareQuery.error))
    : null;

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
        onClick={() => void compareQuery.refetch()}
        disabled={!pairValid || loading}
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
