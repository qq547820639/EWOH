/* Task 4 / P1：CommandMap 门面控制器 Hook（useCommandMapController）。
 *
 * 组合：store slices（唯一状态源）+ React Query 权威聚合（useCommandMapSchedulerState）
 * + 稳定 memo 化命令（selectTask / selectPlan / locateEntity / mode 转换 / replay 控制 /
 * viewport / decisionContext）。
 *
 * 单一事实源约定：
 * - selection.taskId/planId/entityId 只经本控制器写 store（组件禁止自持副本）；
 * - 无效 id 一律解析为 null（绝不回退到列表首个方案）——selectPlan 对照权威 plans 校验，
 *   selectTask 对照 snapshot.tasks 与各方案 assignments 校验；
 * - entity 选中来自可信来源（地图点击/搜索/冲突定位），store 原样写入，
 *   展示层 EntityDetail 自身已有空值兜底（不在地图侧强制列表校验，避免冲突资源
 *   id 与空间实体 id 不一致时「定位地图」失效）。
 * - schedulerRealtime 为 React Query + SSE Provider 数据的镜像 slice：
 *   plans/conflicts 由本控制器 effect 写入，SSE 连接字段由 CommandMapStoreSseBridge
 *   （必须在 SchedulerRealtimeProvider 内）写入；React Query 仍是拉取层，数据流不变。
 */
import { useCallback, useEffect, useMemo, type ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useCommandMapStore,
  type DecisionContextSource,
  type ReplaySlice,
  type SelectionType,
  type ViewportSlice,
  type VisibleBounds,
} from '../store/commandMapStore';
import { useCommandMapSchedulerState, type CommandMapSchedulerState } from './useCommandMapSchedulerState';
import { useSchedulerRealtime } from '@client/src/scheduler/SchedulerRealtimeProvider';
import type { MapLevel, MapMode, ModeSideEffect } from '../map-mode-machine';
import type { SchedulingPlanV2 } from '@shared/api.interface';

export interface CommandMapController {
  // ---- selection（唯一真源 = store.selection）----
  selectedTaskId: string | null;
  selectedPlanId: string | null;
  selectedEntityId: string | null;
  selectionType: SelectionType;
  selectTask: (id: string | null) => void;
  selectPlan: (id: string | null) => void;
  selectEntity: (id: string | null) => void;
  clearSelection: (type?: SelectionType) => void;

  // ---- mode / level（经 map-mode-machine 校验联动）----
  mode: MapMode;
  level: MapLevel;
  setMode: (next: string) => ModeSideEffect[];
  setLevel: (level: MapLevel) => void;

  // ---- replay（对齐 replay.ts 语义）----
  replay: ReplaySlice;
  setReplayMode: (active: boolean) => void;
  setReplayPaused: (paused: boolean) => void;
  setReplaySpeed: (speed: number) => void;
  setReplayTime: (time: string | null) => void;
  /**
   * 播放循环专用：只更新回放时间戳，不触碰 paused。
   * setReplayTime 是「用户手动拖动时间轴」语义（拖动即暂停）；播放循环若复用它
   * 推进帧，每推进一帧 paused 都会被置 true → 回放永远只动一帧就「自动暂停」。
   */
  setReplayTimestamp: (time: string | null) => void;
  toggleReplay: () => void;
  toggleReplayPause: () => void;

  // ---- viewport ----
  viewport: ViewportSlice;
  /** 仅订阅 visibleBounds（避免 x/y/scale 每帧写入导致的重渲染）。 */
  viewportBounds: VisibleBounds | null;
  setViewport: (patch: Partial<ViewportSlice>) => void;
  setViewportBounds: (bounds: VisibleBounds | null) => void;

  // ---- decisionContext ----
  decisionContext: { context: Record<string, unknown> | null; source: DecisionContextSource };
  setDecisionContext: (
    context: Record<string, unknown> | null,
    source: DecisionContextSource,
  ) => void;
  clearDecisionContext: () => void;

  // ---- React Query 权威聚合（数据流不变）----
  scheduler: CommandMapSchedulerState;
  /** 当前选中方案（无效/缺失 → null，绝不回退到列表首个方案）。 */
  activePlan: SchedulingPlanV2 | null;
}

/**
 * SSE 连接状态 → store.schedulerRealtime 镜像桥（渲染 null）。
 * 必须在 <SchedulerRealtimeProvider> 内挂载（useSchedulerRealtime 依赖 Provider）。
 */
export function CommandMapStoreSseBridge(): ReactElement | null {
  const rt = useSchedulerRealtime();
  const setSchedulerRealtime = useCommandMapStore((s) => s.setSchedulerRealtime);

  useEffect(() => {
    setSchedulerRealtime({
      lastEventSeq: rt.lastSequence,
      connected: rt.statusV2 !== 'OFFLINE',
      connectionState: rt.statusV2,
      snapshotVersion: rt.snapshotVersion,
      lastEventTime: rt.lastEventTime,
    });
  }, [
    rt.lastSequence,
    rt.statusV2,
    rt.snapshotVersion,
    rt.lastEventTime,
    setSchedulerRealtime,
  ]);

  return null;
}

export function useCommandMapController(): CommandMapController {
  const scheduler = useCommandMapSchedulerState();

  // ---- store slices（按 slice 订阅，互不干扰）----
  const selection = useCommandMapStore(useShallow((s) => s.selection));
  const viewport = useCommandMapStore(useShallow((s) => s.viewport));
  const viewportBounds = useCommandMapStore((s) => s.viewport.visibleBounds);
  const mode = useCommandMapStore((s) => s.mode);
  const level = useCommandMapStore((s) => s.level);
  const replay = useCommandMapStore(useShallow((s) => s.replay));
  const decisionContext = useCommandMapStore(useShallow((s) => s.decisionContext));

  const actions = useCommandMapStore(
    useShallow((s) => ({
      setSelectedTask: s.setSelectedTask,
      setSelectedPlan: s.setSelectedPlan,
      setSelectedEntity: s.setSelectedEntity,
      clearSelection: s.clearSelection,
      setViewport: s.setViewport,
      setMode: s.setMode,
      setLevel: s.setLevel,
      setReplay: s.setReplay,
      setSchedulerRealtime: s.setSchedulerRealtime,
      setDecisionContext: s.setDecisionContext,
      clearDecisionContext: s.clearDecisionContext,
    })),
  );

  // ---- schedulerRealtime 镜像：React Query 权威 plans/conflicts 写入 store slice ----
  useEffect(() => {
    actions.setSchedulerRealtime({ plans: scheduler.plans });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler.plans]);
  useEffect(() => {
    actions.setSchedulerRealtime({ conflicts: scheduler.conflicts.items ?? [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler.conflicts]);

  // ---- 无效选中 → null（数据变化后重校验，绝不保留悬空 id）----
  useEffect(() => {
    const { planId } = useCommandMapStore.getState().selection;
    if (planId && !scheduler.plans.some((p) => p.planId === planId)) {
      actions.setSelectedPlan(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler.plans]);
  useEffect(() => {
    const taskId = useCommandMapStore.getState().selection.taskId;
    if (!taskId) return;
    const inSnapshot = scheduler.snapshot?.tasks.some((t) => t.id === taskId) ?? false;
    const inPlan = scheduler.plans.some((p) => p.assignments.some((a) => a.taskId === taskId));
    if (!inSnapshot && !inPlan) actions.setSelectedTask(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler.snapshot, scheduler.plans]);

  // ---- selection 命令（写入口唯一）----
  const selectTask = useCallback(
    (id: string | null) => {
      if (id == null) {
        actions.setSelectedTask(null);
        return;
      }
      const inSnapshot = scheduler.snapshot?.tasks.some((t) => t.id === id) ?? false;
      const inPlan = scheduler.plans.some((p) => p.assignments.some((a) => a.taskId === id));
      actions.setSelectedTask(inSnapshot || inPlan ? id : null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduler.snapshot, scheduler.plans],
  );

  const selectPlan = useCallback(
    (id: string | null) => {
      if (id == null) {
        actions.setSelectedPlan(null);
        return;
      }
      const valid = scheduler.plans.some((p) => p.planId === id);
      actions.setSelectedPlan(valid ? id : null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduler.plans],
  );

  const selectEntity = useCallback(
    (id: string | null) => actions.setSelectedEntity(id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clearSelection = useCallback(
    (type?: SelectionType) => actions.clearSelection(type),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- mode / level ----
  const setMode = useCallback((next: string) => actions.setMode(next), [actions]);
  const setLevel = useCallback((level: MapLevel) => actions.setLevel(level), [actions]);

  // ---- replay 控制（读 getState 保持回调稳定）----
  const setReplayMode = useCallback(
    (active: boolean) => {
      if (active) actions.setReplay({ active: true, paused: false, timestamp: null });
      else actions.setReplay({ active: false });
    },
    [actions],
  );
  const setReplayPaused = useCallback((paused: boolean) => actions.setReplay({ paused }), [actions]);
  const setReplaySpeed = useCallback((speed: number) => actions.setReplay({ speed }), [actions]);
  const setReplayTime = useCallback(
    (time: string | null) => {
      actions.setReplay(time ? { timestamp: time, paused: true } : { timestamp: null });
    },
    [actions],
  );
  // 播放循环专用（见接口注释）：不置 paused。
  const setReplayTimestamp = useCallback(
    (time: string | null) => {
      actions.setReplay(time ? { timestamp: time } : { timestamp: null });
    },
    [actions],
  );
  const toggleReplay = useCallback(() => {
    const { active } = useCommandMapStore.getState().replay;
    if (active) actions.setReplay({ active: false });
    else actions.setReplay({ active: true, paused: false, timestamp: null });
  }, [actions]);
  const toggleReplayPause = useCallback(() => {
    const { active, paused } = useCommandMapStore.getState().replay;
    if (!active) {
      actions.setReplay({ active: true, paused: false, timestamp: null });
      return;
    }
    actions.setReplay({ paused: !paused });
  }, [actions]);

  // ---- viewport ----
  const setViewport = useCallback((patch: Partial<ViewportSlice>) => actions.setViewport(patch), [actions]);
  const setViewportBounds = useCallback(
    (bounds: VisibleBounds | null) => actions.setViewport({ visibleBounds: bounds }),
    [actions],
  );

  // ---- decisionContext ----
  const setDecisionContext = useCallback(
    (context: Record<string, unknown> | null, source: DecisionContextSource) =>
      actions.setDecisionContext(context, source),
    [actions],
  );
  const clearDecisionContext = useCallback(() => actions.clearDecisionContext(), [actions]);

  // ---- 派生：当前选中方案（无回退）----
  const activePlan = useMemo(
    () => scheduler.plans.find((p) => p.planId === selection.planId) ?? null,
    [scheduler.plans, selection.planId],
  );

  return {
    selectedTaskId: selection.taskId,
    selectedPlanId: selection.planId,
    selectedEntityId: selection.entityId,
    selectionType: selection.selectionType,
    selectTask,
    selectPlan,
    selectEntity,
    clearSelection,

    mode,
    level,
    setMode,
    setLevel,

    replay,
    setReplayMode,
    setReplayPaused,
    setReplaySpeed,
    setReplayTime,
    setReplayTimestamp,
    toggleReplay,
    toggleReplayPause,

    viewport,
    viewportBounds,
    setViewport,
    setViewportBounds,

    decisionContext,
    setDecisionContext,
    clearDecisionContext,

    scheduler,
    activePlan,
  };
}
