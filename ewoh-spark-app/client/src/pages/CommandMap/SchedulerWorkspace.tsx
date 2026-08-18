/* Task 8 / 8.1：调度方案工作台（调度方案标签页）。
 *
 * 拥有 SchedulePanel（React.lazy 独立 chunk）的组合；选中方案/人员等状态
 * 仍唯一存于 zustand store（store.selectedPlanId），本组件仅按 props 接线渲染。
 */
import React from 'react';
import type { ReactElement } from 'react';
import type { PersonnelInfo, ReplanPreviewResult, SchedulingPlanV2 } from '@shared/api.interface';
import { MapPanelFallback } from './CommandMapShell';

const SchedulePanel = React.lazy(() => import('./panels/SchedulePanel'));

interface SchedulerWorkspaceProps {
  focusPlanId?: string | null;
  onFocusPlanConsumed?: () => void;
  /** 在调度模式地图上高亮某方案受影响人员 */
  onViewOnMap?: (personIds: string[]) => void;
  /** 当前选中方案 id（store 唯一真源派生，经 props 注入）。 */
  selectedPlanId?: string | null;
  /** 选中方案变更回调（plan 为 null 表示取消选中）。 */
  onSelectPlan?: (plan: SchedulingPlanV2 | null) => void;
  /** 人员列表（用于调整指派/解释说明）。 */
  personnel?: PersonnelInfo[];
  /** REPLAN dry-run 预览上抛（地图 changed-by-replan 图层接线，审计 C12）。 */
  onReplanPreviewChange?: (preview: ReplanPreviewResult | null) => void;
}

const SchedulerWorkspace = ({
  focusPlanId,
  onFocusPlanConsumed,
  onViewOnMap,
  selectedPlanId,
  onSelectPlan,
  personnel,
  onReplanPreviewChange,
}: SchedulerWorkspaceProps): ReactElement => (
  <React.Suspense fallback={<MapPanelFallback />}>
    <SchedulePanel
      focusPlanId={focusPlanId}
      onFocusPlanConsumed={onFocusPlanConsumed}
      onViewOnMap={onViewOnMap}
      selectedPlanId={selectedPlanId}
      onSelectPlan={onSelectPlan}
      personnel={personnel}
      onReplanPreviewChange={onReplanPreviewChange}
    />
  </React.Suspense>
);

export default SchedulerWorkspace;
