/* Task 8 / 8.1：地图视口区域（CommandMap 中地图专属 JSX + 处理器）。
 *
 * 仅负责地图本身：FactoryMap + 调度叠加层 SVG（SchedulerLayersOverlay / PlanCompareLayer）
 * + 地图级控制（小屏模式/层级选择器）+ 地图区工作台（智能调度 / 方案对比）。
 * 数据全部经 props 由 CommandMapShell 注入；状态仍唯一存于 zustand store /
 * useCommandMapController，本组件不自持任何状态。
 *
 * 注意：返回 Fragment（不产生额外 DOM 节点），保证绝对定位叠加层与 CommandMapShell
 * 中 ModePanel / EntityDetail 的相对定位与分解前完全一致（零渲染回归）。
 */
import React from 'react';
import type { ReactElement } from 'react';
import type {
  CurrentWorldState,
  EnvironmentReading,
  PlanCompareResult,
  RouteGraph,
  SchedulingConflict,
  SchedulingPlanV2,
  SpatialEntity,
  TaskCandidatesResponse,
} from '@shared/api.interface';
import FactoryMap from './FactoryMap';
import { computeViewBox } from './factoryMapUtils';
import { MODES as MODE_ITEMS } from './ModePanel';
import { SchedulerLayersOverlay } from './layers/SchedulerLayers';
import { PlanCompareLayer } from './layers/PlanCompareLayer';
import type { CommandMapSchedulerState } from './hooks/useCommandMapSchedulerState';
import { toggleLayer, type CommandMapLayer } from './hooks/commandMapSelector';
import type { MapLevel, MapMode } from './map-mode-machine';
import type { VisibleBounds } from './store/viewportCulling';
import type { PlanCompareMapVM, PlanCompareUiState } from './vm/planCompareVM';
import IntelligenceWorkspace from './IntelligenceWorkspace';
import PlanCompareWorkspace from './PlanCompareWorkspace';

interface MapViewportProps {
  entities: SpatialEntity[];
  /** 回放模式下为回放世界状态（由 CommandMapShell 派生）。 */
  worldState: CurrentWorldState | null;
  environmentReadings: EnvironmentReading[];
  mode: MapMode;
  level: MapLevel;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  replayMode: boolean;
  replayTime: string | null;
  /** 调度模式：高亮某方案受影响人员（来自调度面板「在图上查看」）。 */
  focusPlanPersons: string[];
  onFocusPlanPersonsConsumed: () => void;
  /** FactoryMap planOverlay 稳定引用（memo 化，避免每次渲染新建对象）。 */
  planOverlay: { plan: SchedulingPlanV2 | null; routeGraph: RouteGraph | null };
  candidates: TaskCandidatesResponse | null;
  selectedTaskId: string | null;
  /** 视口 culling 可见范围（世界坐标）；null = 不启用 culling。 */
  visibleBounds: VisibleBounds | null;
  /**
   * NO-13e / ADR-054：视口变换上报（FactoryMap pan/zoom → 世界可视范围），
   * CommandMapShell → store viewport.visibleBounds（culling 生产接线）。
   */
  onVisibleBoundsChange?: (bounds: VisibleBounds | null) => void;
  /** 调度聚合状态（P3-T3 hook，供叠加层渲染）。 */
  schedulerState: CommandMapSchedulerState;
  selectedPlanId: string | null;
  // ---- Plan Compare 叠加层 ----
  showCompare: boolean;
  compareVm: PlanCompareMapVM | null;
  compareUi: PlanCompareUiState;
  compareUnchangedPoints: Array<{ taskId: string; point: { x: number; y: number } }>;
  compareResult: PlanCompareResult | null;
  onFocusCompareTask: (taskId: string | null) => void;
  onCompareUiChange: (next: PlanCompareUiState) => void;
  onToggleCompare: () => void;
  onCloseDiff: () => void;
  // ---- 冲突预览叠加层 ----
  previewConflict: SchedulingConflict | null;
  previewDiffVm: PlanCompareMapVM | null;
  // ---- 智能调度工作台 ----
  activePlan: SchedulingPlanV2 | null;
  showIntelligence: boolean;
  showWorkspace: boolean;
  onToggleIntelligence: () => void;
  onToggleWorkspace: () => void;
  onSelectTask: (taskId: string | null) => void;
  onCloseIntelligence: () => void;
  // ---- 小屏模式/层级控件 ----
  setMode: (next: string) => void;
  onLevelSelect: (level: MapLevel) => void;
}

/** 冲突预览叠加层无 diff 聚焦（模块级稳定 no-op，保持 PlanCompareLayer memo 生效）。 */
const handleNoopFocusTask = (): void => undefined;

/** R-6：调度叠加图层开关清单（base 恒为底层不在清单内）。 */
const LAYER_ITEMS: Array<{ key: CommandMapLayer; label: string }> = [
  { key: 'task', label: '任务' },
  { key: 'resource', label: '资源' },
  { key: 'availability', label: '可用性' },
  { key: 'reservation', label: '预占' },
  { key: 'plan', label: '方案' },
  { key: 'route', label: '路线' },
  { key: 'conflict', label: '冲突' },
  { key: 'risk', label: '风险' },
  { key: 'execution-deviation', label: '执行偏差' },
  { key: 'changed-by-replan', label: '重排变更' },
  { key: 'human-locked', label: '人工锁定' },
];

const MapViewport = ({
  entities,
  worldState,
  environmentReadings,
  mode,
  level,
  selectedEntityId,
  onSelectEntity,
  replayMode,
  replayTime,
  focusPlanPersons,
  onFocusPlanPersonsConsumed,
  planOverlay,
  candidates,
  selectedTaskId,
  visibleBounds,
  onVisibleBoundsChange,
  schedulerState,
  selectedPlanId,
  showCompare,
  compareVm,
  compareUi,
  compareUnchangedPoints,
  compareResult,
  onFocusCompareTask,
  onCompareUiChange,
  onToggleCompare,
  onCloseDiff,
  previewConflict,
  previewDiffVm,
  activePlan,
  showIntelligence,
  showWorkspace,
  onToggleIntelligence,
  onToggleWorkspace,
  onSelectTask,
  onCloseIntelligence,
  setMode,
  onLevelSelect,
}: MapViewportProps): ReactElement => (
  <>
    <FactoryMap
      entities={entities}
      worldState={worldState}
      environmentReadings={environmentReadings}
      mode={mode}
      level={level}
      selectedEntityId={selectedEntityId}
      onSelectEntity={onSelectEntity}
      replayMode={replayMode}
      replayTime={replayTime}
      focusPlanPersons={focusPlanPersons}
      onFocusPlanPersonsConsumed={onFocusPlanPersonsConsumed}
      planOverlay={planOverlay}
      candidates={candidates}
      selectedTaskId={selectedTaskId}
      visibleBounds={visibleBounds}
      onVisibleBoundsChange={onVisibleBoundsChange}
    />

    {/* Phase 3 / P3-T3：纯视觉叠加层（conflict/risk/reservation/availability 等，数据来自 hook 聚合状态） */}
    {mode === 'scheduling' && (() => {
      // 坐标系修复（2026-08-19）：叠加层必须与 base 层（FactoryMap）共享同一
      // viewBox（computeViewBox(entities)）。原 computeAggregateViewBox 按调度
      // 快照坐标（旧布局 150-585）计算，与空间实体新布局（62-720）错位 →
      // 路线/方案/冲突等叠加内容画在视图外被裁剪（"图层开启没变化/看不到通道"）。
      const vb = computeViewBox(entities);
      return (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <SchedulerLayersOverlay
            state={schedulerState}
            // P0-8：Plan 层与 SchedulePanel 共享同一选中方案（selection owner：store.selectedPlanId）。
            selectedPlanId={selectedPlanId}
          />
          {showCompare && compareVm && (
            <PlanCompareLayer
              vm={compareVm}
              focusedTaskId={compareUi.focusedTaskId}
              onFocusTask={onFocusCompareTask}
              unchangedTaskIds={compareVm.unchangedTaskIds}
              unchangedPoints={compareUnchangedPoints}
            />
          )}
          {previewConflict && previewDiffVm && (
            <PlanCompareLayer
              vm={previewDiffVm}
              focusedTaskId={null}
              onFocusTask={handleNoopFocusTask}
              unchangedTaskIds={[]}
            />
          )}
        </svg>
      );
    })()}

    {/* 智能调度驾驶舱：开关 + 叠加层（仅调度模式且有方案时展示后端数据图层） */}
    <IntelligenceWorkspace
      mode={mode}
      activePlan={activePlan}
      selectedTaskId={selectedTaskId}
      showIntelligence={showIntelligence}
      showWorkspace={showWorkspace}
      entities={entities}
      worldState={worldState}
      candidates={candidates}
      onToggleIntelligence={onToggleIntelligence}
      onToggleWorkspace={onToggleWorkspace}
      onSelectTask={onSelectTask}
      onCloseIntelligence={onCloseIntelligence}
    />

    {/* Phase 4 / P4-COMPARE：Plan Compare（开关 + 面板 + Diff Drawer） */}
    <PlanCompareWorkspace
      mode={mode}
      showCompare={showCompare}
      compareUi={compareUi}
      onUiChange={onCompareUiChange}
      compareResult={compareResult}
      compareVm={compareVm}
      onToggleCompare={onToggleCompare}
      onOpenDiff={onFocusCompareTask}
      onCloseDiff={onCloseDiff}
    />

    {/* R-6 / ADR-035：调度叠加图层开关（桌面端；移动端小屏控件见下）。 */}
    <div className="absolute left-2 top-2 z-30 hidden max-w-[calc(100%-1rem)] items-center gap-1.5 md:flex">
      <div className="flex flex-wrap gap-0.5 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 p-0.5">
        {LAYER_ITEMS.map((item) => {
          const active = schedulerState.ui.activeLayers.includes(item.key);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => schedulerState.updateUi({ activeLayers: toggleLayer(schedulerState.ui.activeLayers, item.key) })}
              aria-pressed={active}
              aria-label={`切换${item.label}图层`}
              className={`h-6 rounded px-1.5 text-[10px] font-medium ${
                active ? 'bg-semantic-info text-white' : 'text-white/60 hover:text-white/90'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {schedulerState.ui.activeLayers.includes('execution-deviation') &&
        schedulerState.executionsError && (
          <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
            执行记录加载失败
          </span>
        )}
    </div>

    {/* 小屏模式/层级控件 */}
    <div className="absolute left-2 top-2 z-30 flex max-w-[calc(100%-1rem)] items-center gap-1.5 md:hidden">
      <select
        value={mode}
        onChange={(event) => setMode(event.target.value)}
        className="h-8 max-w-[150px] rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 px-2 text-xs text-white outline-none"
        aria-label="切换地图模式"
      >
        {MODE_ITEMS.map((item) => (
          <option key={item.key} value={item.key}>
            {item.name}
          </option>
        ))}
      </select>
      <div className="flex gap-0.5 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 p-0.5">
        {(['L0', 'L1', 'L2', 'L3', 'L4'] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onLevelSelect(l)}
            aria-pressed={level === l}
            aria-label={`切换到${l}层级`}
            className={`h-7 min-w-7 rounded px-1 text-[10px] font-medium ${
              level === l ? 'bg-semantic-info text-white' : 'text-white/60'
            }`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  </>
);

export default MapViewport;
