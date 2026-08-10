/* Task 8 / 8.1：CommandMap 顶层编排壳（CommandMapShell）。
 *
 * 由 Task 8 从原 CommandMap.tsx（~1304 行）分解而来：持有布局（地图视口 + 顶栏 +
 * 模式面板 + 实体详情 + 底部标签栏 + 面板区 + 覆盖层 + 快捷键 + live region +
 * 新鲜度行）与全部编排状态（activeTab / compareUi / previewConflict 等本地 UI state，
 * 以及经 useCommandMapController 的唯一状态源门面）；地图专属 JSX/处理器移至
 * MapViewport，各标签页面板组合移至对应 Workspace 组件。
 *
 * 状态所有权不变：mode/level/selection/replay/schedulerRealtime/decisionContext
 * 仍唯一存于 zustand store（useCommandMapController 唯一控制器），本壳不复制。
 */
import React from 'react';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  AlertCircle,
  GitBranch,
  Hammer,
  Users,
  Workflow,
  Brain,
  X,
  PanelTop,
  TriangleAlert,
  SlidersHorizontal,
  Gauge,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { getEntities } from '../../api/spatial';
import { createReplayItem, getReplay, getWorldState } from '../../api/world';
import { getRoutes, getTaskCandidates } from '../../api/scheduler';
import {
  getOverview,
  getEvents,
  handleEvent,
  getEnvironmentSummary,
  searchDevices,
} from '../../api/dashboard';
import { listOrganizations, listPersonnel } from '../../api/organization';
import type {
  ConflictPreviewResult,
  CurrentWorldState,
  DecisionTrace,
  DeviceInfo,
  EnvironmentReading,
  EventInfo,
  OrganizationInfo,
  OverviewStats,
  PersonnelInfo,
  PlanCompareResult,
  PlanOverrideKind,
  ReplaySnapshot,
  RouteGraph,
  SchedulingConflict,
  SchedulingPlanV2,
  SchedulingContextResponse,
  SpatialEntity,
  TaskCandidatesResponse,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { OPERATIONAL_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '@client/src/hooks/queryConfig';
import { getCurrentOperator } from '../../lib/auth';
import {
  advanceReplayTime,
  findNearestSnapshot,
  snapshotToWorldState,
} from './replay';
import TopBar from './TopBar';
import ModePanel, { MODES as MODE_ITEMS } from './ModePanel';
import { isValidMode, transitionMode, type MapLevel } from './map-mode-machine';
import EntityDetail from './EntityDetail';
import AlertToast from '../../components/AlertToast';
import DataStates from '../../components/DataStates';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useCommandMapSchedulerState } from './hooks/useCommandMapSchedulerState';
import { useCommandMapController, CommandMapStoreSseBridge } from './hooks/useCommandMapController';
import {
  useUrlOperatorContext,
  type UrlIdKind,
  type UrlInvalidIdNotice,
  type UrlOperatorContext,
} from './hooks/useUrlOperatorContext';
import { SchedulerRealtimeProvider, useSchedulerRealtime } from '@client/src/scheduler/SchedulerRealtimeProvider';
import { isContextStale } from './hooks/schedulerRealtimeCore';
import { useSchedulerRealtimeSlice } from './store/commandMapStore';
import { isNavigatorOnline } from '@client/src/lib/offlineStatus';
import {
  classifyFreshness,
  freshnessReason,
  FRESHNESS_STATUS_LABELS,
} from '@client/src/lib/dataFreshness';
import { FRESHNESS_STATUS_CLASSES } from '@client/src/components/DataFreshnessBadge';
import { planCompareMapVM, extractUnchangedTasks, DEFAULT_PLAN_COMPARE_UI, type PlanCompareUiState } from './vm/planCompareVM';
import { useQuery as useQueryCompare } from '@tanstack/react-query';
import { comparePlansV2 } from '@client/src/api/scheduler';
import { UI_ARIA_LABELS } from '../../lib/a11y';
import {
  collectQueryErrors,
  retryAll,
  type QueryStateSnapshot,
} from './queryState';
import MapViewport from './MapViewport';
import ReplayWorkspace from './ReplayWorkspace';
import SchedulerWorkspace from './SchedulerWorkspace';
import ConflictWorkspace from './ConflictWorkspace';
import DecisionCockpitWorkspace from './DecisionCockpitWorkspace';

// 按需懒加载 (Task 9 代码分割)：各底部面板仅在对应标签激活时渲染。
// React.lazy 将重/低频组件拆分为独立 chunk，降低 CommandMap 主 chunk 的传载体积。
// （各 Workspace 组件内另持有本工作台专属面板的 lazy 声明，chunk 拆分不回归。）
const EventCenterPanel = React.lazy(() => import('./panels/EventCenterPanel'));
// v0.7 A3：统一冲突中心 / 人工覆盖中心（接线已有 useSchedulerConflicts / usePlanOverrides hook）
const OverridePanel = React.lazy(() => import('./panels/OverridePanel'));
const WorkbenchPanel = React.lazy(() => import('./panels/WorkbenchPanel'));
const ResourcePoolPanel = React.lazy(() => import('./panels/ResourcePoolPanel'));
const TaskOrchestrationPanel = React.lazy(() => import('./panels/TaskOrchestrationPanel'));
const BrainPanel = React.lazy(() => import('./panels/BrainPanel'));
// Task 5 / P1：全局 Data Freshness 指示行（每事实源一个徽标）。
const DataFreshnessIndicatorRow = React.lazy(() => import('./components/DataFreshnessIndicatorRow'));

/** 懒加载 chunk 加载期间的轻量占位，避免空白闪烁。 */
export const MapPanelFallback = () => (
  <div className="flex h-full w-full items-center justify-center text-xs text-white/50">
    加载中…
  </div>
);

/** 调度实时连接状态徽标（Task 9/10：统一 Data Freshness 词汇）。
 * 原 REALTIME_STATUS_V2_META（实时/降级/重同步/离线）已并入 lib/dataFreshness：
 * SchedulerRealtime V2 连接态经 classifyFreshness 映射为唯一状态词汇
 * （RESYNCING / DEGRADED / OFFLINE / LIVE 等），本徽标只消费统一模型。 */
function SchedulerRealtimeBadge({
  context,
  contextStale,
}: {
  context: SchedulingContextResponse | null;
  contextStale: boolean;
}) {
  const rt = useSchedulerRealtime();
  const status = classifyFreshness({
    lastUpdatedAt: rt.lastEventTime,
    connectionState: rt.statusV2,
    connected: rt.statusV2 !== 'OFFLINE',
  });
  const metaCls = FRESHNESS_STATUS_CLASSES[status];
  const reason = freshnessReason({
    lastUpdatedAt: rt.lastEventTime,
    connectionState: rt.statusV2,
    connected: rt.statusV2 !== 'OFFLINE',
  });
  const lastTime = rt.lastEventTime
    ? new Date(rt.lastEventTime).toLocaleTimeString('zh-CN', { hour12: false })
    : '—';
  const asOfTime = context?.sourceTimestamp
    ? new Date(context.sourceTimestamp).toLocaleTimeString('zh-CN', { hour12: false })
    : null;
  return (
    <div
      className="absolute right-2 top-2 z-40 flex items-center gap-1.5 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 px-2 py-1 text-[10px] text-white/80 shadow-lg"
      title={`调度实时连接状态 · ${reason}`}
    >
      <span className={`rounded border px-1 font-medium ${metaCls}`}>{FRESHNESS_STATUS_LABELS[status]}</span>
      {contextStale && (
        <span
          className="rounded border border-red-500/50 bg-red-500/20 px-1 font-bold text-red-400"
          title="活跃方案与统一调度上下文（/api/scheduler/context）版本不一致，可能展示混合版本数据"
        >
          STALE CONTEXT
        </span>
      )}
      <span className="tabular-nums text-white/60">seq {rt.lastSequence}</span>
      <span className="tabular-nums text-white/60" title="最近事件时间">
        {lastTime}
      </span>
      {context ? (
        <span
          className="tabular-nums text-white/60"
          title={`统一调度上下文：asOf ${context.sourceTimestamp} · 快照 v${context.snapshotVersion} · 资源 v${context.resourceVersion} · 路由图 v${context.routeGraphVersion} · 策略 v${context.policyVersion}`}
        >
          S{context.snapshotVersion} R{context.resourceVersion} G{context.routeGraphVersion} P{context.policyVersion}
        </span>
      ) : rt.snapshotVersion ? (
        <span className="text-white/60" title="快照版本">
          v{rt.snapshotVersion}
        </span>
      ) : null}
      {asOfTime && (
        <span className="tabular-nums text-white/60" title={`asOf ${context?.sourceTimestamp ?? ''}`}>
          asOf {asOfTime}
        </span>
      )}
    </div>
  );
}

interface TabItem {
  key: string;
  label: string;
  icon: LucideIcon;
}

const TABS: TabItem[] = [
  { key: 'timeline', label: '时间轴', icon: Clock },
  { key: 'events', label: '事件中心', icon: AlertCircle },
  { key: 'schedule', label: '调度方案', icon: GitBranch },
  // v0.7 A3：统一冲突中心（消费 GET /api/scheduler/conflicts）
  { key: 'conflicts', label: '冲突中心', icon: TriangleAlert },
  // v0.7 A3：人工覆盖中心（消费 POST /plans/:id/overrides）
  { key: 'override', label: '人工覆盖', icon: SlidersHorizontal },
  { key: 'workbench', label: '班组长工作台', icon: Hammer },
  { key: 'resource', label: '资源池', icon: Users },
  { key: 'orchestration', label: '任务编排', icon: Workflow },
  { key: 'brain', label: '大脑建议', icon: Brain },
  // Task 5 / P1：Decision Cockpit 统一决策上下文（9 段：发生了什么/为什么/影响/...）。
  { key: 'decision', label: '决策驾驶舱', icon: Gauge },
];

const MODES = MODE_ITEMS.map((m) => m.key);

const HELP_ITEMS: Array<{ key: string; desc: string }> = [
  { key: '1-9', desc: '切换地图模式' },
  { key: 'L', desc: '切换 L0-L4 层级' },
  { key: 'T', desc: '进入/退出回放' },
  { key: '空格', desc: '暂停/继续回放' },
  { key: 'Esc', desc: '取消选中' },
  { key: 'F', desc: '全屏' },
  { key: '/', desc: '聚焦搜索框' },
  { key: '?', desc: '显示快捷键帮助' },
];

/** 单个人员的调度解释（why / 备选 / 路由估算），供详情面板展示。 */
interface PlanAssignmentExplanation {
  taskId: string;
  reasons: string[];
  alternatives: Array<Record<string, unknown>>;
  stationId: string | null;
  /** 后端权威路线距离（km，Solver 同源 RouteCost）；无则 undefined。 */
  routeDistanceM?: number;
  /** 后端权威路线 ETA（秒）；无则 undefined。 */
  routeEtaSeconds?: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  /** P0：后端 DecisionTrace（priority 分解/约束证据/版本），前端只展示不计算。 */
  decisionTrace?: DecisionTrace | null;
}

const CommandMapShell = (): React.ReactElement => {
  // Task 4 / P1：唯一状态源门面控制器——selection/mode/level/replay/viewport/decisionContext
  // 写入统一经 controller→store；本组件不再自持上述副本。
  const ctl = useCommandMapController();
  const mode = ctl.mode;
  const setMode = ctl.setMode;
  const level = ctl.level;
  const setLevel = ctl.setLevel;
  const selectedEntityId = ctl.selectedEntityId;
  const setSelectedEntityId = ctl.selectEntity;
  const selectedTaskId = ctl.selectedTaskId;
  const selectedPlanId = ctl.selectedPlanId;
  const replayMode = ctl.replay.active;
  const replayPaused = ctl.replay.paused;
  const replaySpeed = ctl.replay.speed;
  const replayTime = ctl.replay.timestamp;
  const setReplayPaused = ctl.setReplayPaused;
  const setReplaySpeed = ctl.setReplaySpeed;
  const setReplayTime = ctl.setReplayTime;
  const [activeTab, setActiveTab] = useState<string>('timeline');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [focusPlanId, setFocusPlanId] = useState<string | null>(null);
  const [focusPlanPersons, setFocusPlanPersons] = useState<string[]>([]);
  // Task 5 / P1：决策驾驶舱 Lock/Exclude → 人工覆盖面板的初始动作模式。
  const [overrideInitialKind, setOverrideInitialKind] = useState<PlanOverrideKind | null>(null);
  // 智能调度驾驶舱：选中的任务（用于拉取后端候选资源）与驾驶舱面板显隐。
  const [showIntelligence, setShowIntelligence] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  // Phase 4 / P4-COMPARE：Plan Compare UI state（三模式 + 聚焦）。
  const [showCompare, setShowCompare] = useState(false);
  const [compareUi, setCompareUi] = useState<PlanCompareUiState>(DEFAULT_PLAN_COMPARE_UI);
  // Phase 4 / P4-PREVIEW：冲突处置工作台（预览冲突 + 地图 diff）。
  const [previewConflict, setPreviewConflict] = useState<SchedulingConflict | null>(null);
  const [previewResult, setPreviewResult] = useState<ConflictPreviewResult | null>(null);
  // Phase 3 / P3-T3：聚合状态 Hook（React Query 权威数据 + SSE 增量 + 本地 UI state）。
  const schedulerState = useCommandMapSchedulerState();
  // 当前选中方案由 store 唯一真源 selectedPlanId 派生：无效/缺失 → null
  // （controller 对照权威 plans 校验），绝不回退首个方案。
  const activePlan = ctl.activePlan;
  // P1-D：统一调度上下文（版本边界 + dataQuality）+ STALE CONTEXT 判定。
  // 任一活跃方案（含选中方案）与 context.snapshotVersion 不一致 → 醒目标记，不静默混合。
  const schedulerContext = schedulerState.context ?? null;
  const contextStale = useMemo(
    () => isContextStale({ context: schedulerContext, plans: schedulerState.plans, activePlan }),
    [schedulerContext, schedulerState.plans, activePlan],
  );

  // Phase 4 / P4-COMPARE：对比结果（后端权威 diff）+ 地图 VM。
  const compareResultQuery = useQueryCompare<PlanCompareResult | null>({
    queryKey: ['scheduler-compare', compareUi.baselinePlanId, compareUi.candidatePlanId],
    queryFn: async () => {
      if (!compareUi.baselinePlanId || !compareUi.candidatePlanId || compareUi.baselinePlanId === compareUi.candidatePlanId) {
        return null;
      }
      return comparePlansV2(compareUi.baselinePlanId, compareUi.candidatePlanId);
    },
    enabled: showCompare && !!compareUi.baselinePlanId && !!compareUi.candidatePlanId,
  });
  const compareResult = compareResultQuery.data ?? null;
  const compareVm = useMemo(() => {
    if (!compareResult) return null;
    const vm = planCompareMapVM(compareResult, compareUi.mode, schedulerState.snapshot ?? null);
    // 未变化任务（候选方案中未触及的 assignment）作低干扰上下文。
    if (compareUi.mode === 'DIFF' && compareResult.candidatePlanId) {
      const cand = schedulerState.plans?.find((p) => p.planId === compareResult.candidatePlanId);
      if (cand) vm.unchangedTaskIds = extractUnchangedTasks(compareResult, cand.assignments);
    }
    return vm;
  }, [compareResult, compareUi.mode, schedulerState]);
  const [showHelp, setShowHelp] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const replayTimeRef = useRef<string | null>(null);
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  const helpPreviousFocusRef = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();

  // 静态空间实体，30 秒刷新
  const {
    data: entities,
    isError: entitiesError,
    dataUpdatedAt: entitiesUpdatedAt,
    refetch: refetchEntities,
  } = useQuery<SpatialEntity[]>({
    queryKey: queryKeys.spatialEntities,
    queryFn: () => getEntities(),
    refetchInterval: OPERATIONAL_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 动态世界状态，2 秒刷新
  const {
    data: worldState,
    isError: worldError,
    dataUpdatedAt: worldUpdatedAt,
    refetch: refetchWorld,
  } = useQuery<CurrentWorldState>({
    queryKey: queryKeys.worldState,
    queryFn: ({ signal }) => getWorldState(signal),
    refetchInterval: 2000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // KPI，5 秒刷新
  const {
    data: overview,
    isError: overviewError,
    dataUpdatedAt: overviewUpdatedAt,
    refetch: refetchOverview,
  } = useQuery<OverviewStats>({
    queryKey: queryKeys.overview,
    queryFn: getOverview,
    refetchInterval: 5000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 回放快照：非回放时 30 秒刷新，回放中冻结
  const {
    data: replaySnapshots,
    isLoading: replayLoading,
    isError: replayError,
  } = useQuery<ReplaySnapshot[]>({
    queryKey: queryKeys.replaySnapshots,
    queryFn: ({ signal }) => getReplay(undefined, undefined, 120, signal),
    refetchInterval: replayMode ? 0 : 30000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const {
    data: environmentReadings,
    isError: environmentError,
    dataUpdatedAt: environmentUpdatedAt,
    refetch: refetchEnvironment,
  } = useQuery<EnvironmentReading[]>({
    queryKey: queryKeys.environmentSummary,
    queryFn: getEnvironmentSummary,
    refetchInterval: 30000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const querySnapshots = useMemo<QueryStateSnapshot[]>(
    () => [
      {
        key: 'entities',
        label: '空间实体',
        isError: entitiesError,
        dataUpdatedAt: entitiesUpdatedAt,
        refetch: refetchEntities,
      },
      {
        key: 'world',
        label: '世界状态',
        isError: worldError,
        dataUpdatedAt: worldUpdatedAt,
        refetch: refetchWorld,
      },
      {
        key: 'overview',
        label: '总览指标',
        isError: overviewError,
        dataUpdatedAt: overviewUpdatedAt,
        refetch: refetchOverview,
      },
      {
        key: 'environment',
        label: '环境数据',
        isError: environmentError,
        dataUpdatedAt: environmentUpdatedAt,
        refetch: refetchEnvironment,
      },
    ],
    [
      entitiesError,
      entitiesUpdatedAt,
      refetchEntities,
      worldError,
      worldUpdatedAt,
      refetchWorld,
      overviewError,
      overviewUpdatedAt,
      refetchOverview,
      environmentError,
      environmentUpdatedAt,
      refetchEnvironment,
    ],
  );
  const failedQueries = useMemo(
    () => collectQueryErrors(querySnapshots),
    [querySnapshots],
  );

  const { data: organizations } = useQuery<OrganizationInfo[]>({
    queryKey: queryKeys.organizations,
    queryFn: listOrganizations,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const { data: personnel } = useQuery<PersonnelInfo[]>({
    queryKey: queryKeys.personnel(),
    queryFn: () => listPersonnel(),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const {
    data: devices,
    dataUpdatedAt: devicesUpdatedAt,
  } = useQuery<DeviceInfo[]>({
    queryKey: queryKeys.devices({ pageSize: 200 }),
    queryFn: () => searchDevices({ pageSize: 200 }),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const { data: events } = useQuery<EventInfo[]>({
    queryKey: queryKeys.events(),
    queryFn: () => getEvents(200),
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 调度路由图（供调度方案覆盖层渲染拥堵/阻断边）
  const { data: routeGraph } = useQuery<RouteGraph>({
    queryKey: ['schedule-route-graph'],
    queryFn: getRoutes,
    refetchInterval: 30000,
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 智能调度驾驶舱：选中任务时拉取后端候选资源（只读展示，不本地复算资格）。
  const { data: candidates } = useQuery<TaskCandidatesResponse | null>({
    queryKey: queryKeys.schedulerTaskCandidates(selectedTaskId ?? 'none'),
    queryFn: () =>
      selectedTaskId ? getTaskCandidates(selectedTaskId) : Promise.resolve<TaskCandidatesResponse | null>(null),
    enabled: !!selectedTaskId && mode === 'scheduling',
    staleTime: QUERY_STALE_TIME_MS,
  });

  // 离开调度模式或清空方案时，重置任务选择与驾驶舱面板（store 唯一真源写入）。
  useEffect(() => {
    if (mode !== 'scheduling') {
      if (ctl.selectedTaskId) ctl.selectTask(null);
      setShowIntelligence(false);
    }
  }, [mode, ctl.selectedTaskId, ctl.selectTask]);
  useEffect(() => {
    if (!activePlan && ctl.selectedTaskId) ctl.selectTask(null);
  }, [activePlan, ctl.selectedTaskId, ctl.selectTask]);

  const entityList = entities ?? [];
  const state = worldState ?? null;

  // 由当前选中方案构建「人员 → 调度解释」映射，供详情面板展示 why / 备选 / 路由估算
  const planExplanation = useMemo(() => {
    if (!activePlan) return null;
    const map: Map<string, PlanAssignmentExplanation> = new Map();
    const posOf = (id: string | null) => {
      if (!id) return null;
      const e = entityList.find((x) => x.entityId === id);
      return e ? { x: e.x, y: e.y } : null;
    };
    for (const a of activePlan.assignments) {
      if (!a.personId) continue;
      // P0：路线距离/ETA 使用后端权威值（Solver 同源 RouteCost），
      // 禁止前端 Math.hypot 复算权威距离；缺失时显式 undefined（不猜测）。
      const routeDistanceM =
        typeof a.distanceMeters === 'number'
          ? a.distanceMeters / 1000
          : undefined;
      const routeEtaSeconds =
        typeof a.etaSeconds === 'number' ? a.etaSeconds : undefined;
      map.set(a.personId, {
        taskId: a.taskId,
        reasons: a.reasons,
        alternatives: a.alternatives,
        stationId: a.stationId,
        routeDistanceM,
        routeEtaSeconds,
        plannedStart: a.plannedStart,
        plannedEnd: a.plannedEnd,
        // P0：DecisionTrace 透传（priority 分解/被拒替代/策略与求解器版本），
        // 前端只展示后端计算值，禁止自行复算。
        decisionTrace: a.decisionTrace ?? null,
      });
    }
    return map;
  }, [activePlan]);

  // 回放模式下用最近快照替换实时世界状态
  const replayWorldState = useMemo(() => {
    if (!replayMode || !replayTime || !replaySnapshots?.length) return null;
    const snapshot = findNearestSnapshot(replaySnapshots, replayTime);
    return snapshot ? snapshotToWorldState(snapshot, state) : null;
  }, [replayMode, replayTime, replaySnapshots, state]);

  const displayWorldState = replayMode && replayWorldState ? replayWorldState : state;

  useEffect(() => {
    replayTimeRef.current = replayTime;
  }, [replayTime]);

  // 在调度模式地图上高亮某方案受影响人员
  const handleViewOnMap = useCallback((personIds: string[]) => {
    setFocusPlanPersons(personIds);
    // v0.7 Batch10.3：经状态机计算调度模式转换（含层级联动 L3）
    const next = transitionMode(
      { mode: isValidMode(mode) ? mode : 'production', level, replay: { active: replayMode, paused: replayPaused } },
      'scheduling',
    );
    if (next) {
      setMode(next.state.mode);
      setLevel(next.state.level);
    } else {
      setMode('scheduling');
    }
  }, [mode, level, replayMode, replayPaused]);

  // 真实回放播放循环：按倍速逐快照推进
  useEffect(() => {
    if (!replayMode || replayPaused || !replaySnapshots?.length) return;
    if (!replayTimeRef.current) {
      const firstTs = replaySnapshots[0].ts;
      replayTimeRef.current = firstTs;
      setReplayTime(firstTs);
      return;
    }
    const timer = window.setInterval(() => {
      const next = advanceReplayTime(replaySnapshots, replayTimeRef.current);
      replayTimeRef.current = next;
      setReplayTime(next);
    }, Math.max(200, 1000 / replaySpeed));
    return () => window.clearInterval(timer);
  }, [replayMode, replayPaused, replaySpeed, replaySnapshots, setReplayTime]);

  // 聚焦事件：打开事件中心并选中事件，同时尝试定位关联设备
  const focusEventEntity = useCallback(
    (eventId: string) => {
      setActiveTab('events');
      setSelectedEventId(eventId);
      const list = entities ?? [];
      getEvents(50, undefined)
        .then((events) => {
          const evt = events.find((e) => e.eventId === eventId || e.id === eventId);
          if (evt?.deviceId) {
            const entity = list.find(
              (e) => e.entityType === 'device' && e.entityId.includes(evt.deviceId),
            );
            if (entity) setSelectedEntityId(entity.entityId);
          }
      })
        .catch(() => {});
    },
    [entities],
  );

  // ---- Task 9 / 9.1：URL 背书的操作上下文（镜像 ⇄ 恢复；深链聚焦）----
  // 写规则：一律 history.replaceState——mode/level/selection/tab/冲突/事件/回放时间戳/
  // compare 均属连续变化，不入历史栈；后退/前进只跨真实导航（深链/外部跳转），
  // 与操作员直觉一致。瞬态 UI（对话框/动画/抽屉可见性）不镜像。
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
          const inSnapshot = schedulerState.snapshot?.tasks.some((t) => t.id === id) ?? false;
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
  const isValidUrlTab = useCallback((tab: string) => TABS.some((t) => t.key === tab), []);

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
          // ConflictVMItem 为 SchedulingConflict 展示子集，预览面板所需字段齐全。
          setPreviewConflict({
            conflictId: vmItem.conflictId,
            type: vmItem.type,
            severity: vmItem.severity,
            scope: vmItem.scope,
            resourceId: vmItem.resourceId,
            resourceType: vmItem.resourceType,
            taskIds: vmItem.taskIds,
            message: vmItem.message,
            resolution: vmItem.resolution,
            createdAt: vmItem.detectedAt ?? '',
            snapshotVersion: null,
            status: vmItem.status,
            detectedAt: vmItem.detectedAt,
            acknowledgedBy: vmItem.acknowledgedBy,
            resolvedBy: vmItem.resolvedBy,
            suppressUntil: vmItem.suppressUntil,
          } as SchedulingConflict);
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
    [ctl, schedulerState.conflicts, focusEventEntity],
  );

  // 失效 id 通知：toast 瞬态提示；内联 banner 由返回的 notices 渲染。
  const handleInvalidUrlIds = useCallback((invalid: UrlInvalidIdNotice[]) => {
    for (const notice of invalid) {
      toast.warning(notice.message, { description: `URL 参数 ${notice.kind}_id=${notice.id}` });
    }
  }, []);

  const { notices: urlNotices, dismissNotice: dismissUrlNotice } = useUrlOperatorContext({
    state: urlCtx,
    ready: !schedulerState.loading,
    onRestore: restoreUrlContext,
    validateId: validateUrlId,
    isValidTab: isValidUrlTab,
    onInvalidId: handleInvalidUrlIds,
  });

  // 层级循环 L0 → L1 → L2 → L3 → L4 → L0
  const handleLevelToggle = useCallback(() => {
    const next =
      level === 'L0'
        ? 'L1'
        : level === 'L1'
          ? 'L2'
          : level === 'L2'
            ? 'L3'
            : level === 'L3'
              ? 'L4'
              : 'L0';
    // L3/L4 近景需先选中目标实体，无选中时回退原层级并提示，避免画面迷失
    if ((next === 'L3' || next === 'L4') && !selectedEntityId) {
      toast.info(`请先在地图上选中${next === 'L3' ? '一个工位' : '一名人员'}再进入近景`);
      return;
    }
    setLevel(next);
  }, [level, selectedEntityId, setLevel]);

  // 侧栏/小屏直接选择层级：L3/L4 同样需先选中实体，与键盘守卫保持一致
  const handleLevelSelect = useCallback(
    (target: 'L0' | 'L1' | 'L2' | 'L3' | 'L4') => {
      if ((target === 'L3' || target === 'L4') && !selectedEntityId) {
        toast.info(`请先在地图上选中${target === 'L3' ? '一个工位' : '一名人员'}再进入近景`);
        return;
      }
      setLevel(target);
    },
    [selectedEntityId],
  );

  // 回放切换 / 暂停 / 模式变更 / 时间变更（统一经 controller→store）
  const handleReplayToggle = ctl.toggleReplay;
  const handleReplayPauseToggle = ctl.toggleReplayPause;
  const handleReplayModeChange = ctl.setReplayMode;
  const handleReplayTimeChange = ctl.setReplayTime;

  // 全屏切换
  const handleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  // 搜索聚焦
  const handleSearchFocus = useCallback(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showHelp) {
      helpPreviousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => helpCloseRef.current?.focus());
    } else if (helpPreviousFocusRef.current) {
      helpPreviousFocusRef.current.focus();
      helpPreviousFocusRef.current = null;
    }
  }, [showHelp]);

  // 键盘快捷键
  useKeyboardShortcuts({
    modes: MODES,
    onModeChange: setMode,
    onLevelToggle: handleLevelToggle,
    onReplayToggle: handleReplayToggle,
    onReplayPauseToggle: handleReplayPauseToggle,
    onCancelSelection: () => setSelectedEntityId(null),
    onFullscreen: handleFullscreen,
    onSearchFocus: handleSearchFocus,
    onShowHelp: () => setShowHelp((prev) => !prev),
    enabled: true,
  });

  // 告警处置：定位并打开具体事件
  const handleViewEvent = useCallback(
    (eventId: string) => {
      focusEventEntity(eventId);
    },
    [focusEventEntity],
  );

  const handleHandleEvent = useCallback(
    (eventId: string) => {
      focusEventEntity(eventId);
      handleEvent(eventId, {
        handlerAction: 'manual_handle',
        handlerNote: '指挥地图快速处置',
        operator: getCurrentOperator(),
      })
        .then(() => {
          toast.success('事件已处置');
          queryClient.invalidateQueries({ queryKey: ['events'] });
        })
        .catch((err) => {
          toast.error('处置失败', {
            description: err instanceof Error ? err.message : undefined,
          });
        });
    },
    [focusEventEntity, queryClient],
  );

  const handleSelectReplayEvent = useCallback(
    (eventId: string) => {
      focusEventEntity(eventId);
    },
    [focusEventEntity],
  );

  const createReplayItemMutation = useMutation({
    mutationFn: (event: { eventId: string; title: string; ts: string }) =>
      createReplayItem({
        eventId: event.eventId,
        kind: 'issue',
        title: `跟进：${event.title}`,
        replayTime: event.ts,
      }),
    onSuccess: () => {
      toast.success('已从回放创建跟进问题');
    },
    onError: (error) => {
      toast.error('创建跟进问题失败', {
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });

  // ---- 稳定回调（供 React.memo 子组件跳过无关重渲染，Task 4 / P1）----
  const handleFocusPlanPersonsConsumed = useCallback(() => setFocusPlanPersons([]), []);
  const handleFocusPlanConsumed = useCallback(() => setFocusPlanId(null), []);
  const handleSelectPlan = useCallback(
    (plan: SchedulingPlanV2 | null) =>
      ctl.selectPlan(plan?.planId ?? null),
    [ctl.selectPlan],
  );
  const handleCloseEntity = useCallback(() => ctl.selectEntity(null), [ctl.selectEntity]);
  const handleOpenDisposition = useCallback((eventId: string) => {
    setActiveTab('events');
    setSelectedEventId(eventId);
  }, []);
  const handleFocusCompareTask = useCallback(
    (taskId: string | null) => setCompareUi((u) => ({ ...u, focusedTaskId: taskId })),
    [],
  );
  // 关闭 PlanDiffDrawer（清空 compareUi 聚焦任务）。
  const handleCloseCompareDiff = useCallback(
    () => setCompareUi((u) => ({ ...u, focusedTaskId: null })),
    [],
  );
  const handleConflictReplan = useCallback(() => {
    setActiveTab('schedule');
  }, []);
  const handleLocateEntity = useCallback(
    (entityId: string | null) => {
      if (entityId) {
        ctl.selectEntity(entityId);
        setPanelExpanded(false);
      }
    },
    [ctl.selectEntity],
  );
  const handleConflictPreview = useCallback((conflict: SchedulingConflict) => {
    setPreviewConflict(conflict);
    setPreviewResult(null);
  }, []);

  // ---- 地图区工作台显隐 / 冲突预览 / 决策驾驶舱动作（原 CommandMap JSX 内联箭头，等价提取）----
  const handleToggleIntelligence = useCallback(() => setShowIntelligence((v) => !v), []);
  const handleCloseIntelligence = useCallback(() => setShowIntelligence(false), []);
  const handleToggleWorkspace = useCallback(() => setShowWorkspace((v) => !v), []);
  const handleToggleCompare = useCallback(() => setShowCompare((v) => !v), []);
  const handleClosePreview = useCallback(() => {
    setPreviewConflict(null);
    setPreviewResult(null);
  }, []);
  const handleConflictApply = useCallback((conflict: SchedulingConflict) => {
    // Human Apply：关闭预览并跳转调度面板执行正式 replan（新方案生成 + 审批）。
    setPreviewConflict(null);
    setPreviewResult(null);
    setActiveTab('schedule');
    toast.info(`冲突 ${conflict.conflictId} 已确认处置，请在方案面板审批新方案`);
  }, []);
  const handleOpenCompare = useCallback(() => setShowCompare(true), []);
  const handleOpenOverride = useCallback((kind?: PlanOverrideKind) => {
    setOverrideInitialKind(kind ?? null);
    setActiveTab('override');
  }, []);

  // PlanCompare 未变化任务坐标（稳定引用，供 PlanCompareLayer memo）。
  const compareUnchangedPoints = useMemo(
    () =>
      compareVm
        ? compareVm.unchangedTaskIds
            .map((tid) => {
              const st = schedulerState.snapshot?.stations.find((s) => s.id === tid);
              const pt = st ? { x: st.x, y: st.y } : null;
              return pt ? { taskId: tid, point: pt } : null;
            })
            .filter((x): x is { taskId: string; point: { x: number; y: number } } => x != null)
        : [],
    [compareVm, schedulerState.snapshot],
  );

  // 冲突预览地图 diff VM（稳定引用，供 PlanCompareLayer memo）。
  const previewDiffVm = useMemo(
    () =>
      previewResult?.diff
        ? planCompareMapVM(previewResult.diff, 'DIFF', schedulerState.snapshot ?? null)
        : null,
    [previewResult, schedulerState.snapshot],
  );

  // FactoryMap planOverlay 稳定引用（memo 化，避免每次渲染新建对象）。
  const planOverlayMemo = useMemo(
    () => ({ plan: activePlan, routeGraph: routeGraph ?? null }),
    [activePlan, routeGraph],
  );

  // Task 5 / P1：全局 Data Freshness 指示行——每事实源一个徽标。
  // 调度方案/调度上下文源用 store.schedulerRealtime（lastEventTime + connectionState），
  // 世界·设备源用 React Query dataUpdatedAt + navigator.onLine；
  // 关键规则：SSE 断开（connectionState=OFFLINE/connected=false）时绝不显示 LIVE。
  const schedulerRealtime = useSchedulerRealtimeSlice();
  const freshnessSources = useMemo(() => {
    const contextTs = schedulerContext?.sourceTimestamp
      ? Date.parse(schedulerContext.sourceTimestamp)
      : NaN;
    const worldDevTs = Math.max(worldUpdatedAt, devicesUpdatedAt);
    return [
      {
        key: 'scheduler-plans',
        label: '调度方案',
        lastUpdatedAt: schedulerRealtime.lastEventTime,
        connectionState: schedulerRealtime.connectionState,
        connected: schedulerRealtime.connected,
        replayActive: ctl.replay.active,
        shadowMode: activePlan?.status === 'shadow',
      },
      {
        key: 'world-devices',
        label: '世界·设备',
        lastUpdatedAt: worldDevTs > 0 ? worldDevTs : null,
        connected: isNavigatorOnline(),
      },
      {
        key: 'scheduler-context',
        label: '调度上下文',
        lastUpdatedAt: Number.isFinite(contextTs) ? contextTs : null,
        connectionState: schedulerRealtime.connectionState,
        connected: schedulerRealtime.connected,
      },
    ];
  }, [schedulerRealtime, schedulerContext?.sourceTimestamp, worldUpdatedAt, devicesUpdatedAt, activePlan, ctl.replay.active]);

  // Task 5 / P1：人员 id → 姓名（TaskMoveExplain old→new 展示用）。
  const personNameOf = useMemo(
    () => (id: string | null): string | null => {
      if (!id) return null;
      const p = personnel?.find((pp) => pp.id === id || pp.employeeNo === id);
      return p?.name ?? null;
    },
    [personnel],
  );

  return (
    <SchedulerRealtimeProvider>
      {/* SSE 连接状态 → store.schedulerRealtime 镜像（渲染 null，必须位于 Provider 内） */}
      <CommandMapStoreSseBridge />
      <div
        id="command-map-main"
        tabIndex={-1}
        className="fixed inset-0 z-50 flex flex-col bg-[hsl(220_14%_10%)] text-white"
      >
      <a
        href="#command-map-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[hsl(221_83%_53%)] focus:shadow-lg"
      >
        跳到地图主体
      </a>
      <div className="sr-only" role="status" aria-live="polite">
        {`地图模式：${MODE_ITEMS.find((item) => item.key === mode)?.name ?? mode}；层级：${level}；${
          replayMode ? (replayPaused ? '回放已暂停' : `回放中，${replaySpeed} 倍速`) : '实时模式'
        }`}
      </div>
      {/* 顶部 KPI 栏 + 搜索 */}
      <TopBar
        overview={overview ?? null}
        worldState={displayWorldState}
        onBack={() => window.history.back()}
        entities={entityList}
        onSelectEntity={setSelectedEntityId}
        searchRef={searchRef}
      />

      {/* Task 5 / P1：全局数据新鲜度指示行（每事实源一个徽标） */}
      <React.Suspense fallback={null}>
        <DataFreshnessIndicatorRow sources={freshnessSources} />
      </React.Suspense>

      {/* Task 9 / 9.1：URL 失效 id 内联 banner（toast 已另行提示，可关闭） */}
      {urlNotices.length > 0 && (
        <div
          role="alert"
          aria-live="polite"
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
        >
          <TriangleAlert className="w-4 h-4 shrink-0 text-amber-400" />
          <span className="text-xs text-amber-200">
            {urlNotices.map((n) => n.message).join('；')}
          </span>
          <button
            type="button"
            onClick={() => urlNotices.forEach((_, i) => dismissUrlNotice(i))}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-amber-300/80 hover:bg-amber-500/10"
            aria-label={UI_ARIA_LABELS.closeUrlNotices}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {failedQueries.length > 0 && (
        <div className="mx-4 mt-3">
          <DataStates
            health="degraded"
            message={`部分数据加载失败：${failedQueries.map((query) => query.label).join('、')}`}
            detail="地图主体仍可浏览，失败的数据会在恢复后自动刷新。"
            onRetry={() => retryAll(failedQueries)}
          />
        </div>
      )}

      {/* 中间三栏：左模式 / 中地图 / 右详情 */}
      <div className="relative flex-1 min-h-0 flex">
        <ModePanel mode={mode} onModeChange={setMode} level={level} onLevelChange={handleLevelSelect} />

        <MapViewport
          entities={entityList}
          worldState={displayWorldState}
          environmentReadings={environmentReadings ?? []}
          mode={mode}
          level={level}
          selectedEntityId={selectedEntityId}
          onSelectEntity={ctl.selectEntity}
          replayMode={replayMode}
          replayTime={replayTime}
          focusPlanPersons={focusPlanPersons}
          onFocusPlanPersonsConsumed={handleFocusPlanPersonsConsumed}
          planOverlay={planOverlayMemo}
          candidates={candidates ?? null}
          selectedTaskId={selectedTaskId}
          visibleBounds={ctl.viewportBounds}
          schedulerState={schedulerState}
          selectedPlanId={selectedPlanId}
          showCompare={showCompare}
          compareVm={compareVm}
          compareUi={compareUi}
          compareUnchangedPoints={compareUnchangedPoints}
          compareResult={compareResult}
          onFocusCompareTask={handleFocusCompareTask}
          onCompareUiChange={setCompareUi}
          onToggleCompare={handleToggleCompare}
          onCloseDiff={handleCloseCompareDiff}
          previewConflict={previewConflict}
          previewDiffVm={previewDiffVm}
          activePlan={activePlan}
          showIntelligence={showIntelligence}
          showWorkspace={showWorkspace}
          onToggleIntelligence={handleToggleIntelligence}
          onToggleWorkspace={handleToggleWorkspace}
          onSelectTask={ctl.selectTask}
          onCloseIntelligence={handleCloseIntelligence}
          setMode={setMode}
          onLevelSelect={handleLevelSelect}
        />

        <EntityDetail
          entityId={selectedEntityId}
          entities={entityList}
          worldState={displayWorldState}
          personnel={personnel ?? []}
          organizations={organizations ?? []}
          devices={devices ?? []}
          events={events ?? []}
          planExplanation={planExplanation}
          onOpenDisposition={handleOpenDisposition}
          onClose={handleCloseEntity}
        />
      </div>

      {/* 底部标签栏 + 面板区 */}
      <div
        className={cn(
          'shrink-0 flex flex-col bg-[hsl(220_14%_12%)] border-t border-white/10',
          panelExpanded ? 'h-[60vh]' : 'h-[260px] lg:h-[320px]',
        )}
      >
        <div className="flex items-center gap-1 px-3 h-9 border-b border-white/10 bg-[hsl(220_14%_14%)] overflow-x-auto">
          {TABS.map((t) => {
            const active = activeTab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                aria-pressed={active}
                aria-label={`打开${t.label}`}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap',
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-white/70 hover:text-white/80 hover:bg-white/5',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setPanelExpanded((prev) => !prev)}
            aria-pressed={panelExpanded}
            aria-label={panelExpanded ? '收起面板' : '最大化面板'}
            title={panelExpanded ? '收起面板' : '最大化面板'}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-white/70 hover:text-white cursor-pointer"
          >
            <PanelTop
              className={cn(
                'w-3.5 h-3.5 transition-transform',
                panelExpanded && 'rotate-180',
              )}
            />
            {panelExpanded ? '收起' : '最大化'}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'timeline' && (
            <ReplayWorkspace
              snapshots={replaySnapshots}
              isLoading={replayLoading}
              isError={replayError}
              replayMode={replayMode}
              onReplayModeChange={handleReplayModeChange}
              replayTime={replayTime}
              onReplayTimeChange={handleReplayTimeChange}
              paused={replayPaused}
              onPausedChange={setReplayPaused}
              speed={replaySpeed}
              onSpeedChange={setReplaySpeed}
              onSelectEvent={handleSelectReplayEvent}
              onCreateItem={(event) =>
                createReplayItemMutation.mutate({
                  eventId: event.eventId,
                  title: event.title,
                  ts: event.ts,
                })
              }
            />
          )}
          {activeTab === 'events' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <EventCenterPanel
                selectedEventId={selectedEventId}
                onSelectedEventIdChange={setSelectedEventId}
              />
            </React.Suspense>
          )}
          {activeTab === 'schedule' && (
            <SchedulerWorkspace
              focusPlanId={focusPlanId}
              onFocusPlanConsumed={handleFocusPlanConsumed}
              onViewOnMap={handleViewOnMap}
              selectedPlanId={selectedPlanId}
              onSelectPlan={handleSelectPlan}
              personnel={personnel ?? []}
            />
          )}
          {/* v0.7 A3：统一冲突中心 + Phase 4 / P4-PREVIEW 冲突处置工作台（覆盖式） */}
          {(activeTab === 'conflicts' || previewConflict) && (
            <ConflictWorkspace
              activeTab={activeTab}
              previewConflict={previewConflict}
              onReplan={handleConflictReplan}
              onLocateEntity={handleLocateEntity}
              onPreview={handleConflictPreview}
              onClosePreview={handleClosePreview}
              onPreviewDiff={setPreviewResult}
              onApply={handleConflictApply}
            />
          )}
          {/* v0.7 A3：人工覆盖中心（消费 /plans/:id/overrides） */}
          {activeTab === 'override' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <OverridePanel planId={selectedPlanId} initialKind={overrideInitialKind ?? undefined} />
            </React.Suspense>
          )}
          {activeTab === 'workbench' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <WorkbenchPanel
                onNavigate={setActiveTab}
                onModeChange={setMode}
                onSelectEntity={ctl.selectEntity}
              />
            </React.Suspense>
          )}
          {activeTab === 'resource' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <ResourcePoolPanel
                entities={entityList}
                worldState={state}
                planId={selectedPlanId}
              />
            </React.Suspense>
          )}
          {activeTab === 'orchestration' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <TaskOrchestrationPanel
                entities={entityList}
                onOpenSchedule={(planId) => {
                  setFocusPlanId(planId ?? null);
                  setActiveTab('schedule');
                }}
              />
            </React.Suspense>
          )}
          {activeTab === 'brain' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <BrainPanel
                onSelectPlan={(planId) => {
                  setFocusPlanId(planId);
                  setActiveTab('schedule');
                }}
              />
            </React.Suspense>
          )}
          {/* Task 5 / P1：Decision Cockpit 统一决策上下文（9 段） */}
          {activeTab === 'decision' && (
            <DecisionCockpitWorkspace
              planDiff={compareResult ?? previewResult?.diff ?? null}
              onCompare={handleOpenCompare}
              onOverride={handleOpenOverride}
              onLocate={handleLocateEntity}
              personNameOf={personNameOf}
            />
          )}
        </div>
      </div>

      {/* 实时告警弹窗 */}
      <AlertToast onViewEvent={handleViewEvent} onHandleEvent={handleHandleEvent} />

      {/* 快捷键帮助浮层 */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={() => setShowHelp(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcut-help-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setShowHelp(false);
          }}
        >
          <div
            className="bg-[hsl(220_14%_14%)] border border-white/10 rounded-xl p-6 shadow-2xl min-w-[320px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 id="shortcut-help-title" className="text-sm font-semibold text-white">
                快捷键
              </h3>
              <button
                ref={helpCloseRef}
                onClick={() => setShowHelp(false)}
                className="text-white/60 hover:text-white"
                aria-label={UI_ARIA_LABELS.closeHelp}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2">
              {HELP_ITEMS.map((item) => (
                <div key={item.key} className="flex items-center gap-3">
                  <kbd className="px-2 py-0.5 bg-white/10 rounded text-xs text-white font-mono min-w-[40px] text-center">
                    {item.key}
                  </kbd>
                  <span className="text-xs text-white/70">{item.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <SchedulerRealtimeBadge context={schedulerContext} contextStale={contextStale} />
    </div>
    </SchedulerRealtimeProvider>
  );
};

export default CommandMapShell;
