/* CLI-004 拆分：CommandMapShell 的 URL 镜像/恢复编排（机械提取，行为不变）。
 *
 * - urlCtx：当前操作上下文（mode/level/selection/tab/冲突/事件/回放/compare）
 *   → 经 useUrlOperatorContext 写回 URL（history.replaceState，不入历史栈）；
 * - validateUrlId：URL 提供的 id 是否存在于已加载权威数据；
 * - restoreUrlContext：mount/popstate 时恢复上下文 → 写 store / Shell 本地
 *   state（状态所有权不变，仅镜像）；深链聚焦（plan/task/event）。
 * 状态所有权仍唯一存于 zustand store 与 Shell 本地 state，本 hook 不复制。
 */
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import type {
  EventInfo,
  SchedulingConflict,
  SpatialEntity,
} from '@shared/api.interface';
import type { MapLevel } from '../map-mode-machine';
import type { PlanCompareUiState } from '../vm/planCompareVM';
import { conflictVmItemToConflict } from '../vm/conflictVM';
import type { CommandMapController } from './useCommandMapController';
import type { CommandMapSchedulerState } from './useCommandMapSchedulerState';
import {
  useUrlOperatorContext,
  type UrlIdKind,
  type UrlInvalidIdNotice,
  type UrlOperatorContext,
} from './useUrlOperatorContext';

export interface UseCommandMapUrlSyncArgs {
  ctl: CommandMapController;
  activeTab: string;
  selectedEntityId: string | null;
  selectedTaskId: string | null;
  selectedPlanId: string | null;
  selectedEventId: string | null;
  previewConflict: SchedulingConflict | null;
  replayMode: boolean;
  replayTime: string | null;
  showCompare: boolean;
  compareUi: PlanCompareUiState;
  schedulerState: CommandMapSchedulerState;
  entityList: SpatialEntity[];
  events: EventInfo[] | undefined;
  focusEventEntity: (eventId: string) => void;
  setActiveTab: (tab: string) => void;
  setPreviewConflict: (conflict: SchedulingConflict | null) => void;
  setPreviewResult: (result: import('@shared/api.interface').ConflictPreviewResult | null) => void;
  setCompareUi: (
    updater: (prev: PlanCompareUiState) => PlanCompareUiState,
  ) => void;
  setShowCompare: (value: boolean) => void;
  isValidTab: (tab: string) => boolean;
  ready: boolean;
}

export function useCommandMapUrlSync({
  ctl,
  activeTab,
  selectedEntityId,
  selectedTaskId,
  selectedPlanId,
  selectedEventId,
  previewConflict,
  replayMode,
  replayTime,
  showCompare,
  compareUi,
  schedulerState,
  entityList,
  events,
  focusEventEntity,
  setActiveTab,
  setPreviewConflict,
  setPreviewResult,
  setCompareUi,
  setShowCompare,
  isValidTab,
  ready,
}: UseCommandMapUrlSyncArgs): {
  notices: UrlInvalidIdNotice[];
  dismissNotice: (index: number) => void;
} {
  const urlCtx = useMemo<UrlOperatorContext>(
    () => ({
      mode: ctl.mode,
      level: ctl.level,
      entityId: selectedEntityId,
      taskId: selectedTaskId,
      planId: selectedPlanId,
      tab: activeTab,
      conflictId: previewConflict?.conflictId ?? null,
      eventId: selectedEventId,
      replayTs: replayMode ? replayTime : null,
      compareBaseline: showCompare ? compareUi.baselinePlanId : null,
      compareCandidate: showCompare ? compareUi.candidatePlanId : null,
    }),
    [
      ctl.mode,
      ctl.level,
      selectedEntityId,
      selectedTaskId,
      selectedPlanId,
      activeTab,
      previewConflict,
      selectedEventId,
      replayMode,
      replayTime,
      showCompare,
      compareUi.baselinePlanId,
      compareUi.candidatePlanId,
    ],
  );

  // URL 提供的 id 是否存在于已加载权威数据（不存在 → 降级默认 + 用户可见提示）。
  const validateUrlId = useCallback(
    (kind: UrlIdKind, id: string): boolean => {
      switch (kind) {
        case 'plan':
          return schedulerState.plans.some((p) => p.planId === id);
        case 'task': {
          const inSnapshot =
            schedulerState.snapshot?.tasks.some((t) => t.id === id) ?? false;
          const inPlan = schedulerState.plans.some((p) =>
            p.assignments.some((a) => a.taskId === id),
          );
          return inSnapshot || inPlan;
        }
        case 'entity':
          return entityList.some((e) => e.entityId === id);
        case 'conflict':
          return schedulerState.conflicts.items.some((c) => c.conflictId === id);
        case 'event':
          return (events ?? []).some((e) => e.eventId === id || e.id === id);
      }
    },
    [schedulerState.plans, schedulerState.snapshot, schedulerState.conflicts, entityList, events],
  );

  // 恢复 URL 上下文 → 写 store / 本地 state（状态所有权不变，仅镜像）。
  // 深链（plan_id/task_id/event_id）：选中 + 打开对应标签 + 聚焦。
  const restoreUrlContext = useCallback(
    (ctx: UrlOperatorContext) => {
      if (ctx.mode && ctx.mode !== ctl.mode) ctl.setMode(ctx.mode);
      if (ctx.level && ctx.level !== ctl.level) ctl.setLevel(ctx.level as MapLevel);
      if (ctx.entityId) ctl.selectEntity(ctx.entityId);
      if (ctx.taskId) {
        ctl.setMode('scheduling');
        ctl.selectTask(ctx.taskId);
        setActiveTab('schedule');
      }
      if (ctx.planId) {
        ctl.selectPlan(ctx.planId);
        setActiveTab('schedule');
      }
      if (ctx.tab) setActiveTab(ctx.tab);
      if (ctx.conflictId) {
        const vmItem = schedulerState.conflicts.items.find(
          (c) => c.conflictId === ctx.conflictId,
        );
        if (vmItem) {
          // CLI-007：显式构造函数替代手工拼对象 + as 断言（createdAt 用后端原始值）。
          setPreviewConflict(conflictVmItemToConflict(vmItem));
          setPreviewResult(null);
        }
      }
      if (ctx.eventId) {
        setActiveTab('events');
        focusEventEntity(ctx.eventId);
      }
      if (ctx.replayTs) {
        ctl.setReplayMode(true);
        ctl.setReplayTime(ctx.replayTs);
      }
      if (
        ctx.compareBaseline &&
        ctx.compareCandidate &&
        ctx.compareBaseline !== ctx.compareCandidate
      ) {
        setCompareUi((u) => ({
          ...u,
          baselinePlanId: ctx.compareBaseline!,
          candidatePlanId: ctx.compareCandidate!,
          focusedTaskId: null,
        }));
        setShowCompare(true);
      }
    },
    [ctl, schedulerState.conflicts, focusEventEntity, setActiveTab, setPreviewConflict, setPreviewResult, setCompareUi, setShowCompare],
  );

  // 失效 id 通知：toast 瞬态提示；内联 banner 由返回的 notices 渲染。
  const handleInvalidUrlIds = useCallback((invalid: UrlInvalidIdNotice[]) => {
    for (const notice of invalid) {
      toast.warning(notice.message, { description: `URL 参数 ${notice.kind}_id=${notice.id}` });
    }
  }, []);

  const { notices, dismissNotice } = useUrlOperatorContext({
    state: urlCtx,
    ready,
    onRestore: restoreUrlContext,
    validateId: validateUrlId,
    isValidTab,
    onInvalidId: handleInvalidUrlIds,
  });

  return { notices, dismissNotice };
}
