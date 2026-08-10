/* Task 8 / 8.1：冲突工作台（冲突中心标签页 + 冲突处置预览工作台）。
 *
 * 拥有 ConflictCenterPanel 与 ConflictPreviewPanel（均为 React.lazy 独立 chunk）的组合。
 * 预览冲突/预览结果状态仍留在 CommandMapShell（切换标签不丢失），
 * 本组件按 props 接线：activeTab === 'conflicts' 渲染冲突中心；
 * previewConflict 非空渲染处置工作台（覆盖式，与激活标签无关）。
 */
import React from 'react';
import type { ReactElement } from 'react';
import type { ConflictPreviewResult, SchedulingConflict } from '@shared/api.interface';
import { MapPanelFallback } from './CommandMapShell';

const ConflictCenterPanel = React.lazy(() => import('./panels/ConflictCenterPanel'));
const ConflictPreviewPanel = React.lazy(() => import('./panels/ConflictPreviewPanel'));

interface ConflictWorkspaceProps {
  /** 当前激活的底部标签（决定是否渲染冲突中心）。 */
  activeTab: string;
  /** 非空时渲染冲突处置工作台（覆盖式）。 */
  previewConflict: SchedulingConflict | null;
  /** 冲突 → 跳转调度方案面板并触发一次手动重排视野。 */
  onReplan: (conflict: SchedulingConflict) => void;
  /** 点击资源 → 选中地图实体并退出面板聚焦地图。 */
  onLocateEntity: (entityId: string | null) => void;
  /** 打开冲突处置工作台（Preview Replan + 地图 Diff）。 */
  onPreview: (conflict: SchedulingConflict) => void;
  /** 关闭处置工作台。 */
  onClosePreview: () => void;
  /** 预览 diff 上传给地图（复用 PlanCompareLayer 渲染）；null = 清除。 */
  onPreviewDiff: (preview: ConflictPreviewResult | null) => void;
  /** 正式 Apply：关闭预览并跳转调度方案面板执行正式 replan。 */
  onApply: (conflict: SchedulingConflict) => void;
}

const ConflictWorkspace = ({
  activeTab,
  previewConflict,
  onReplan,
  onLocateEntity,
  onPreview,
  onClosePreview,
  onPreviewDiff,
  onApply,
}: ConflictWorkspaceProps): ReactElement => (
  <>
    {activeTab === 'conflicts' && (
      <React.Suspense fallback={<MapPanelFallback />}>
        <ConflictCenterPanel onReplan={onReplan} onLocateEntity={onLocateEntity} onPreview={onPreview} />
      </React.Suspense>
    )}
    {previewConflict && (
      <React.Suspense fallback={<MapPanelFallback />}>
        <ConflictPreviewPanel
          conflict={previewConflict}
          onClose={onClosePreview}
          onPreviewDiff={onPreviewDiff}
          onApply={onApply}
        />
      </React.Suspense>
    )}
  </>
);

export default ConflictWorkspace;
