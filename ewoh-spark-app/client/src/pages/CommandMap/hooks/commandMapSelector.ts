/* Phase 3 / P3-T3 前端：CommandMap 聚合纯选择器（无 React 依赖，可 node 单测）。
 *
 * 职责边界（React Query = server-state cache，SSE = 增量）：
 * 选择器只聚合各查询结果 + UI state → 展示模型；不重算资格/成本，只透传后端字段。
 * useCommandMapSchedulerState（React Hook）组合 React Query 查询后调用本选择器。
 */
import { conflictVM } from '../vm/conflictVM';
import type {
  WorldStateSnapshot,
  SchedulingPlanV2,
  ResourceState,
  RouteGraph,
  SchedulingContextResponse,
} from '@shared/api.interface';
import type { SchedulingExecution } from '@shared/scheduler';

export type CommandMapLayer =
  | 'base'
  | 'task'
  | 'resource'
  | 'availability'
  | 'reservation'
  | 'plan'
  | 'route'
  | 'conflict'
  | 'risk'
  // R-6 / ADR-035：执行偏差图层（planned vs actual）。
  | 'execution-deviation'
  // M05：Replan 叠加层（08 §10）。
  | 'changed-by-replan'
  | 'human-locked';

export type PanelMode = 'schedule' | 'conflict' | 'override' | 'resource' | 'none';

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface CommandMapUIState {
  selectedTaskId: string | null;
  selectedResourceId: string | null;
  selectedPlanId: string | null;
  /**
   * 多图层组合（P0）：可同时开启 Resource+Route+Plan+Conflict 等（调度驾驶舱
   * 正常使用场景）；base 恒为底层不在此列。空数组 = 仅 base。
   */
  activeLayers: CommandMapLayer[];
  panelMode: PanelMode;
  viewport: Viewport;
}

export interface CommandMapAggregate {
  snapshot: WorldStateSnapshot | null;
  resources: ResourceState[];
  plans: SchedulingPlanV2[];
  routes: RouteGraph | null;
  conflicts: ReturnType<typeof conflictVM>;
  /**
   * R-6 / ADR-035：所选方案的执行记录（ewoh_scheduling_execution 权威事实，
   * GET /api/scheduler/executions?planId=…）。无选中方案 → []（显式空态，
   * 不静默透传 null）。执行偏差图层（execution-deviation）消费。
   */
  executions: SchedulingExecution[];
  /** R-6：执行记录查询失败（图层/控件据此显示显式错误态，绝不静默当作空）。 */
  executionsError: boolean;
  ui: CommandMapUIState;
  loading: boolean;
  hasError: boolean;
  /**
   * P1-D：统一调度上下文（GET /api/scheduler/context，Phase 0 交付）。
   * 版本边界（snapshotVersion/resourceVersion/routeGraphVersion/policyVersion/
   * eventSequence/sourceTimestamp）+ dataQuality；未拉到 → null。
   * 可选扩展字段，不改变既有消费方形状。
   */
  context?: SchedulingContextResponse | null;
}

export const DEFAULT_UI_STATE: CommandMapUIState = {
  selectedTaskId: null,
  selectedResourceId: null,
  selectedPlanId: null,
  // 2026-08-18：路线网默认开启——指挥地图打开即显示车间间连接（原默认全关，
  // 只看到 base 静态层，路线边需手动在左上角图层开关点"路线"）。
  activeLayers: ['route'],
  panelMode: 'none',
  viewport: { x: 0, y: 0, scale: 1 },
};

/**
 * UI state 局部合并（纯函数，node 可测）：updateUi 的底层实现。
 *
 * selection owner 约定：selectedTaskId / selectedResourceId / selectedPlanId 只经
 * useCommandMapSchedulerState.updateUi 写入（CommandMap / SchedulePanel 均通过它读写），
 * 各组件禁止自持副本；patch 中未提及的字段原样保留。
 */
export function applyUiPatch(
  prev: CommandMapUIState,
  patch: Partial<CommandMapUIState>,
): CommandMapUIState {
  return { ...prev, ...patch };
}

/** 纯选择器：各查询结果 + UI state → 聚合展示模型（可单测，不重算调度资格）。 */
export function buildCommandMapState(params: {
  snapshot: WorldStateSnapshot | null;
  resources: ResourceState[] | undefined;
  plans: SchedulingPlanV2[] | undefined;
  routes: RouteGraph | null | undefined;
  conflicts: Parameters<typeof conflictVM>[0] | undefined;
  context?: SchedulingContextResponse | null;
  /** R-6：所选方案执行记录；缺省 []（显式空态）。 */
  executions?: SchedulingExecution[] | null;
  /** R-6：执行记录查询失败标记；缺省 false。 */
  executionsError?: boolean;
  ui: CommandMapUIState;
  loading: boolean;
  hasError: boolean;
}): CommandMapAggregate {
  return {
    snapshot: params.snapshot,
    resources: params.resources ?? [],
    plans: params.plans ?? [],
    routes: params.routes ?? null,
    conflicts: conflictVM(params.conflicts ?? []),
    context: params.context ?? null,
    executions: params.executions ?? [],
    executionsError: params.executionsError ?? false,
    ui: params.ui,
    loading: params.loading,
    hasError: params.hasError,
  };
}

/**
 * 图层开关（纯函数，node 可测）：开 → 追加（保持顺序），关 → 移除；
 * 重复开启幂等（不产生重复项）。base 恒为底层，不接受本函数开关。
 */
export function toggleLayer(prev: CommandMapLayer[], layer: CommandMapLayer): CommandMapLayer[] {
  if (layer === 'base') return prev;
  return prev.includes(layer) ? prev.filter((l) => l !== layer) : [...prev, layer];
}
