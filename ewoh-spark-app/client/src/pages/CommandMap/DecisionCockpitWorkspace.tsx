/* Task 8 / 8.1：决策驾驶舱工作台（决策驾驶舱标签页）。
 *
 * 拥有 DecisionCockpit（React.lazy 独立 chunk）的组合；决策上下文/方案 diff 等
 * 数据经 props 由 CommandMapShell 注入，状态不落回本组件。
 */
import React from 'react';
import type { ReactElement } from 'react';
import type { PlanCompareResult, PlanOverrideKind } from '@shared/api.interface';
import { MapPanelFallback } from './CommandMapShell';

const DecisionCockpit = React.lazy(() => import('./panels/DecisionCockpit'));

interface DecisionCockpitWorkspaceProps {
  /** 服务端权威方案 diff（对比 / 冲突预览，可选）。 */
  planDiff: PlanCompareResult | null;
  /** 打开方案对比（CommandMapShell：setShowCompare(true)）。 */
  onCompare: () => void;
  /** 打开人工覆盖（CommandMapShell：切到 override 标签；kind 为初始动作模式）。 */
  onOverride: (kind?: PlanOverrideKind) => void;
  /** 定位实体（CommandMapShell：ctl.selectEntity + 聚焦）。 */
  onLocate: (entityId: string | null) => void;
  /** 人员 id → 姓名（可空；缺省显示原始 id）。 */
  personNameOf: (id: string | null) => string | null;
}

const DecisionCockpitWorkspace = ({
  planDiff,
  onCompare,
  onOverride,
  onLocate,
  personNameOf,
}: DecisionCockpitWorkspaceProps): ReactElement => (
  <React.Suspense fallback={<MapPanelFallback />}>
    <DecisionCockpit
      planDiff={planDiff}
      onCompare={onCompare}
      onOverride={onOverride}
      onLocate={onLocate}
      personNameOf={personNameOf}
    />
  </React.Suspense>
);

export default DecisionCockpitWorkspace;
