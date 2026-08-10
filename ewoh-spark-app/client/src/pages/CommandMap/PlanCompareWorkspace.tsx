/* Task 8 / 8.1：方案对比工作台（地图区 Plan Compare 叠加层）。
 *
 * 拥有 PlanComparePanel + PlanDiffDrawer（均为 React.lazy 独立 chunk）的组合。
 * compareUi / showCompare 状态仍由 CommandMapShell 持有（切换模式不丢失），
 * 本组件仅按 props 接线；挂载条件（mode === 'scheduling'）与分解前一致。
 */
import React from 'react';
import type { ReactElement } from 'react';
import { GitCompareArrows } from 'lucide-react';
import type { PlanCompareResult } from '@shared/api.interface';
import type { MapMode } from './map-mode-machine';
import type { PlanCompareMapVM, PlanCompareUiState } from './vm/planCompareVM';
import { MapPanelFallback } from './CommandMapShell';

const PlanComparePanel = React.lazy(() => import('./panels/PlanComparePanel'));
const PlanDiffDrawer = React.lazy(() => import('./panels/PlanDiffDrawer'));

interface PlanCompareWorkspaceProps {
  mode: MapMode;
  showCompare: boolean;
  compareUi: PlanCompareUiState;
  onUiChange: (next: PlanCompareUiState) => void;
  /** 后端权威 diff 结果（null = 未取到/未开启）。 */
  compareResult: PlanCompareResult | null;
  /** 地图 VM（PlanCompareLayer 同源）。 */
  compareVm: PlanCompareMapVM | null;
  onToggleCompare: () => void;
  onOpenDiff: (taskId: string) => void;
  onCloseDiff: () => void;
}

const PlanCompareWorkspace = ({
  mode,
  showCompare,
  compareUi,
  onUiChange,
  compareResult,
  compareVm,
  onToggleCompare,
  onOpenDiff,
  onCloseDiff,
}: PlanCompareWorkspaceProps): ReactElement => (
  <>
    {mode === 'scheduling' && (
      <button
        type="button"
        onClick={onToggleCompare}
        className="absolute right-2 top-[6.5rem] z-40 flex items-center gap-1 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 px-2 py-1.5 text-[10px] text-white/80 shadow-lg hover:bg-white/10"
        title="Plan Compare：基线/候选/差异三模式"
      >
        <GitCompareArrows className="w-3.5 h-3.5 text-emerald-400" />
        {showCompare ? '关闭对比' : '方案对比'}
      </button>
    )}
    {mode === 'scheduling' && showCompare && (
      <div className="absolute left-2 top-1/2 -translate-y-1/2 z-40">
        <React.Suspense fallback={<MapPanelFallback />}>
          <PlanComparePanel
            ui={compareUi}
            onUiChange={onUiChange}
            onOpenDiff={onOpenDiff}
          />
        </React.Suspense>
      </div>
    )}
    {mode === 'scheduling' && showCompare && compareUi.focusedTaskId && compareResult && (
      <React.Suspense fallback={null}>
        <PlanDiffDrawer
          entry={compareVm?.entries.find((e) => e.taskId === compareUi.focusedTaskId) ?? null}
          diff={compareResult.diffByTask.find((d) => d.taskId === compareUi.focusedTaskId) ?? null}
          onClose={onCloseDiff}
        />
      </React.Suspense>
    )}
  </>
);

export default PlanCompareWorkspace;
