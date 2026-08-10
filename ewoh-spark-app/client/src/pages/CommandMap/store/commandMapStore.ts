/* Task 4 / P1：CommandMap 唯一状态源 Store（zustand v5）。
 *
 * 6 个 slice：selection / viewport / mode / replay / schedulerRealtime / decisionContext，
 * 外加全局 version 计数器——任何 slice 写入 version+1，供组件按需选择性订阅。
 *
 * - selection：任务/方案/实体选中的**唯一真源**。无效 id 一律解析为 null
 *   （绝不回退到列表首个方案）；有效性校验发生在 useCommandMapController
 *   （持有 React Query 权威数据），store 自身只做写入与置空。
 * - viewport：{ x, y, scale, visibleBounds }，culling 派生选择器见 viewportCulling.ts；
 *   x/y/scale 保留给调用方（如未来 zoom-to 通信），默认不绑定
 *   react-zoom-pan-pinch 的每帧内部变换（避免每帧 store 写入）。
 * - mode：复用 map-mode-machine 的状态值与转换规则（transitionMode 为单一事实源），
 *   非法模式拒绝；切换副作用（clear_selected_task 等）由 setMode 返回。
 * - replay：语义对齐 replay.ts / replayContext.ts（active/paused/speed/timestamp/timeline），
 *   时间推进/最近快照等纯函数仍留在 replay.ts。
 * - schedulerRealtime：React Query（权威拉取）+ SchedulerRealtimeProvider（SSE 连接）
 *   数据的**镜像 slice**，写入口在 useCommandMapController / CommandMapStoreSseBridge；
 *   单条 SSE 事件只更新本 slice（及其派生选择器），React Query 数据流保持不变。
 * - decisionContext：决策上下文（conflict/candidate/replan/override 来源）暂存。
 *
 * 订阅隔离：per-slice hooks 用 useShallow，仅本 slice 引用变化时通知订阅者；
 * 测试通过 subscribeWithSelector 的 selector 订阅验证「写 A slice 不通知 B slice 订阅者」。
 */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { subscribeWithSelector } from 'zustand/middleware';
import { transitionMode, type MapLevel, type MapMode, type ModeSideEffect } from '../map-mode-machine';
import type { SchedulerStreamStatusV2 } from '../hooks/schedulerRealtimeCore';
import type { ReplaySnapshot, SchedulingPlanV2 } from '@shared/api.interface';
import type { ConflictVMItem } from '../vm/conflictVM';
import type { VisibleBounds } from './viewportCulling';

export type { VisibleBounds } from './viewportCulling';

export type SelectionType = 'task' | 'plan' | 'entity' | null;

export interface SelectionSlice {
  taskId: string | null;
  planId: string | null;
  entityId: string | null;
  /** 当前选中的种类（task/plan/entity），无选中为 null。 */
  selectionType: SelectionType;
}

export interface ViewportSlice {
  x: number;
  y: number;
  scale: number;
  /** 世界坐标可见范围（工厂坐标系）；null = 不启用 culling（默认渲染全部）。 */
  visibleBounds: VisibleBounds | null;
}

export interface ReplaySlice {
  active: boolean;
  paused: boolean;
  speed: number;
  timestamp: string | null;
  timeline: ReplaySnapshot[] | null;
}

export interface SchedulerRealtimeSlice {
  plans: SchedulingPlanV2[];
  /** 调度运行列表（当前 CommandMap 数据流未暴露 runs，保留字段供未来接线）。 */
  runs: unknown[];
  /** 冲突展示模型（conflictVM 的 items，来自 React Query 权威 conflicts）。 */
  conflicts: ConflictVMItem[];
  lastEventSeq: number;
  connected: boolean;
  connectionState: SchedulerStreamStatusV2;
  snapshotVersion: string | null;
  lastEventTime: number | null;
}

export type DecisionContextSource = 'conflict' | 'candidate' | 'replan' | 'override' | null;

export interface DecisionContextSlice {
  context: Record<string, unknown> | null;
  source: DecisionContextSource;
}

export interface CommandMapStore {
  /** 任何 slice 写入 +1（供组件按 version 选择性订阅）。 */
  version: number;

  selection: SelectionSlice;
  viewport: ViewportSlice;
  mode: MapMode;
  level: MapLevel;
  replay: ReplaySlice;
  schedulerRealtime: SchedulerRealtimeSlice;
  decisionContext: DecisionContextSlice;

  setSelectedTask: (id: string | null) => void;
  setSelectedPlan: (id: string | null) => void;
  setSelectedEntity: (id: string | null) => void;
  /** 清空选中；type 为空时清空全部。 */
  clearSelection: (type?: SelectionType) => void;
  setViewport: (patch: Partial<ViewportSlice>) => void;
  /** 经 map-mode-machine 校验/联动的模式切换；非法模式拒绝。返回副作用清单。 */
  setMode: (next: string) => ModeSideEffect[];
  setLevel: (level: MapLevel) => void;
  setReplay: (patch: Partial<ReplaySlice>) => void;
  setSchedulerRealtime: (patch: Partial<SchedulerRealtimeSlice>) => void;
  setDecisionContext: (context: Record<string, unknown> | null, source: DecisionContextSource) => void;
  clearDecisionContext: () => void;
}

export const DEFAULT_SELECTION: SelectionSlice = {
  taskId: null,
  planId: null,
  entityId: null,
  selectionType: null,
};

export const DEFAULT_VIEWPORT: ViewportSlice = { x: 0, y: 0, scale: 1, visibleBounds: null };

export const DEFAULT_REPLAY: ReplaySlice = {
  active: false,
  paused: false,
  speed: 1,
  timestamp: null,
  timeline: null,
};

export const DEFAULT_SCHEDULER_REALTIME: SchedulerRealtimeSlice = {
  plans: [],
  runs: [],
  conflicts: [],
  lastEventSeq: 0,
  connected: false,
  connectionState: 'CONNECTED',
  snapshotVersion: null,
  lastEventTime: null,
};

export const DEFAULT_DECISION_CONTEXT: DecisionContextSlice = { context: null, source: null };

/** V2 连接状态 → connected 布尔（OFFLINE 视为断开，其余视为在线/降级/重同步中）。 */
export function isRealtimeConnected(status: SchedulerStreamStatusV2): boolean {
  return status !== 'OFFLINE';
}

export const useCommandMapStore = create<CommandMapStore>()(
  subscribeWithSelector((set, get) => ({
    version: 0,
    selection: DEFAULT_SELECTION,
    viewport: DEFAULT_VIEWPORT,
    mode: 'production',
    level: 'L1',
    replay: DEFAULT_REPLAY,
    schedulerRealtime: DEFAULT_SCHEDULER_REALTIME,
    decisionContext: DEFAULT_DECISION_CONTEXT,

    setSelectedTask: (id) =>
      set((s) => ({
        ...s,
        selection: {
          ...s.selection,
          taskId: id,
          selectionType:
            id ? 'task' : s.selection.selectionType === 'task' ? null : s.selection.selectionType,
        },
        version: s.version + 1,
      })),

    setSelectedPlan: (id) =>
      set((s) => ({
        ...s,
        selection: {
          ...s.selection,
          planId: id,
          selectionType:
            id ? 'plan' : s.selection.selectionType === 'plan' ? null : s.selection.selectionType,
        },
        version: s.version + 1,
      })),

    setSelectedEntity: (id) =>
      set((s) => ({
        ...s,
        selection: {
          ...s.selection,
          entityId: id,
          selectionType:
            id ? 'entity' : s.selection.selectionType === 'entity' ? null : s.selection.selectionType,
        },
        version: s.version + 1,
      })),

    clearSelection: (type) =>
      set((s) => {
        const sel = { ...s.selection };
        if (!type || type === 'task') {
          sel.taskId = null;
          if (s.selection.selectionType === 'task') sel.selectionType = null;
        }
        if (!type || type === 'plan') {
          sel.planId = null;
          if (s.selection.selectionType === 'plan') sel.selectionType = null;
        }
        if (!type || type === 'entity') {
          sel.entityId = null;
          if (s.selection.selectionType === 'entity') sel.selectionType = null;
        }
        return { ...s, selection: sel, version: s.version + 1 };
      }),

    setViewport: (patch) =>
      set((s) => ({ ...s, viewport: { ...s.viewport, ...patch }, version: s.version + 1 })),

    setMode: (next) => {
      const st = get();
      const result = transitionMode(
        { mode: st.mode, level: st.level, replay: st.replay },
        next,
      );
      if (!result) return [];
      set((s) => ({
        ...s,
        mode: result.state.mode,
        level: result.state.level,
        version: s.version + 1,
      }));
      return result.effects;
    },

    setLevel: (level) => set((s) => ({ ...s, level, version: s.version + 1 })),

    setReplay: (patch) =>
      set((s) => ({ ...s, replay: { ...s.replay, ...patch }, version: s.version + 1 })),

    setSchedulerRealtime: (patch) =>
      set((s) => ({
        ...s,
        schedulerRealtime: { ...s.schedulerRealtime, ...patch },
        version: s.version + 1,
      })),

    setDecisionContext: (context, source) =>
      set((s) => ({ ...s, decisionContext: { context, source }, version: s.version + 1 })),

    clearDecisionContext: () =>
      set((s) => ({ ...s, decisionContext: DEFAULT_DECISION_CONTEXT, version: s.version + 1 })),
  })),
);

/* ---- per-slice 选择器 hooks（useShallow：仅本 slice 引用变化时触发重渲染） ---- */

export const useSelectionSlice = (): SelectionSlice =>
  useCommandMapStore(useShallow((s) => s.selection));

export const useViewportSlice = (): ViewportSlice =>
  useCommandMapStore(useShallow((s) => s.viewport));

export const useModeSlice = (): { mode: MapMode; level: MapLevel } =>
  useCommandMapStore(useShallow((s) => ({ mode: s.mode, level: s.level })));

export const useReplaySlice = (): ReplaySlice =>
  useCommandMapStore(useShallow((s) => s.replay));

export const useSchedulerRealtimeSlice = (): SchedulerRealtimeSlice =>
  useCommandMapStore(useShallow((s) => s.schedulerRealtime));

export const useDecisionContextSlice = (): DecisionContextSlice =>
  useCommandMapStore(useShallow((s) => s.decisionContext));

export const useCommandMapVersion = (): number => useCommandMapStore((s) => s.version);
