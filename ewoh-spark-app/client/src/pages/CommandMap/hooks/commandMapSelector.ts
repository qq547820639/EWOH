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
} from '@shared/api.interface';

export type CommandMapLayer =
  | 'base'
  | 'task'
  | 'resource'
  | 'availability'
  | 'reservation'
  | 'plan'
  | 'route'
  | 'conflict'
  | 'risk';

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
  activeLayer: CommandMapLayer;
  panelMode: PanelMode;
  viewport: Viewport;
}

export interface CommandMapAggregate {
  snapshot: WorldStateSnapshot | null;
  resources: ResourceState[];
  plans: SchedulingPlanV2[];
  routes: RouteGraph | null;
  conflicts: ReturnType<typeof conflictVM>;
  ui: CommandMapUIState;
  loading: boolean;
  hasError: boolean;
}

export const DEFAULT_UI_STATE: CommandMapUIState = {
  selectedTaskId: null,
  selectedResourceId: null,
  selectedPlanId: null,
  activeLayer: 'base',
  panelMode: 'none',
  viewport: { x: 0, y: 0, scale: 1 },
};

/** 纯选择器：各查询结果 + UI state → 聚合展示模型（可单测，不重算调度资格）。 */
export function buildCommandMapState(params: {
  snapshot: WorldStateSnapshot | null;
  resources: ResourceState[] | undefined;
  plans: SchedulingPlanV2[] | undefined;
  routes: RouteGraph | null | undefined;
  conflicts: Parameters<typeof conflictVM>[0] | undefined;
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
    ui: params.ui,
    loading: params.loading,
    hasError: params.hasError,
  };
}
