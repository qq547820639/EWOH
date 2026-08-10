/* Task 8 / 8.1：智能调度工作台（地图区智能调度图层 + 智能工作台面板）。
 *
 * 拥有 IntelligenceLayers 与 IntelligenceWorkspace 面板（均为 React.lazy 独立 chunk）
 * 的组合；showIntelligence / showWorkspace 显隐状态仍由 CommandMapShell 持有，
 * 本组件仅按 props 接线；挂载条件（mode === 'scheduling'）与分解前一致。
 */
import React from 'react';
import type { ReactElement } from 'react';
import { Activity, Brain } from 'lucide-react';
import type { CurrentWorldState, SchedulingPlanV2, SpatialEntity, TaskCandidatesResponse } from '@shared/api.interface';
import type { MapMode } from './map-mode-machine';
import { MapPanelFallback } from './CommandMapShell';

const IntelligenceLayersPanel = React.lazy(() => import('./panels/IntelligenceLayers'));
const IntelligenceWorkspacePanel = React.lazy(() => import('./panels/IntelligenceWorkspace'));

interface IntelligenceWorkspaceProps {
  mode: MapMode;
  activePlan: SchedulingPlanV2 | null;
  selectedTaskId: string | null;
  showIntelligence: boolean;
  showWorkspace: boolean;
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  candidates: TaskCandidatesResponse | null;
  onToggleIntelligence: () => void;
  onToggleWorkspace: () => void;
  onSelectTask: (taskId: string | null) => void;
  onCloseIntelligence: () => void;
}

const IntelligenceWorkspace = ({
  mode,
  activePlan,
  selectedTaskId,
  showIntelligence,
  showWorkspace,
  entities,
  worldState,
  candidates,
  onToggleIntelligence,
  onToggleWorkspace,
  onSelectTask,
  onCloseIntelligence,
}: IntelligenceWorkspaceProps): ReactElement => (
  <>
    {/* 智能调度驾驶舱：开关 + 叠加层（仅调度模式且有方案时展示后端数据图层） */}
    {mode === 'scheduling' && activePlan && (
      <button
        type="button"
        onClick={onToggleIntelligence}
        className="absolute right-2 top-14 z-40 flex items-center gap-1 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 px-2 py-1.5 text-[10px] text-white/80 shadow-lg hover:bg-white/10"
        title="智能调度驾驶舱图层"
      >
        <Brain className="w-3.5 h-3.5 text-violet-400" />
        智能调度{selectedTaskId ? ' ⚠候选' : ''}
      </button>
    )}
    {mode === 'scheduling' && showIntelligence && (
      <div className="absolute right-2 top-24 bottom-2 z-40 w-[320px]">
        <React.Suspense fallback={<MapPanelFallback />}>
          <IntelligenceLayersPanel
            plan={activePlan}
            entities={entities}
            worldState={worldState}
            candidates={candidates}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            onClose={onCloseIntelligence}
          />
        </React.Suspense>
      </div>
    )}
    {mode === 'scheduling' && (
      <button
        type="button"
        onClick={onToggleWorkspace}
        className="absolute right-2 top-20 z-40 flex items-center gap-1 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 px-2 py-1.5 text-[10px] text-white/80 shadow-lg hover:bg-white/10"
        title="Phase 4 智能工作台：KPI / Policy Replay / Shadow / Activation"
      >
        <Activity className="w-3.5 h-3.5 text-cyan-400" />
        {showWorkspace ? '隐藏工作台' : '智能工作台'}
      </button>
    )}
    {mode === 'scheduling' && showWorkspace && (
      <div className="absolute right-2 bottom-2 z-40">
        <React.Suspense fallback={<MapPanelFallback />}>
          <IntelligenceWorkspacePanel />
        </React.Suspense>
      </div>
    )}
  </>
);

export default IntelligenceWorkspace;
