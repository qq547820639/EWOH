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
import { errorDescription } from '@client/src/lib/errorContract';
import { useNavigate } from 'react-router-dom';
import { createReplayItem } from '../../api/world';
import { getEvents, handleEvent } from '../../api/dashboard';
import type {
  ConflictPreviewResult,
  DecisionTrace,
  PlanCompareResult,
  PlanOverrideKind,
  ReplanPreviewResult,
  SchedulingConflict,
  SchedulingPlanV2,
  SchedulingContextResponse,
} from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { queryKeys } from '@client/src/hooks/queryKeys';
import { logger } from '../../lib/logger';
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
import { useCommandMapQueries } from './hooks/useCommandMapQueries';
import { useCommandMapUrlSync } from './hooks/useCommandMapUrlSync';
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
import {
  comparePlansV2,
  getApprovalStatus,
  requestCapabilityRelaxationApproval,
  updateTaskRequirements,
} from '@client/src/api/scheduler';
import { UI_ARIA_LABELS } from '../../lib/a11y';
import { retryAll } from './queryState';
import { getBrainSuggestions } from '@client/src/api/gamification';
import MapViewport from './MapViewport';
import ReplayWorkspace from './ReplayWorkspace';
import SchedulerWorkspace from './SchedulerWorkspace';
import ConflictWorkspace from './ConflictWorkspace';
import DecisionCockpitWorkspace from './DecisionCockpitWorkspace';
import {
  buildRelaxationApprovalSubject,
  errorText,
  isCapabilityRelaxationApprovalRequired,
  relaxedHighRiskForSave,
} from './vm/taskRequirementsVM';
import { describeCapabilityApprovalFreshness } from '@shared/capability-requirements';

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
    ? new Date(rt.lastEventTime).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
  const asOfTime = context?.sourceTimestamp
    ? new Date(context.sourceTimestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : null;
  return (
    <div
      className="absolute right-2 top-2 z-40 flex items-center gap-1.5 rounded-md border border-white/10 bg-surface-inverse-raised/95 px-2 py-1 text-[10px] text-white/80 shadow-lg"
      title={`调度实时连接状态 · ${reason}`}
    >
      <span className={`rounded border px-1 font-medium ${metaCls}`}>{FRESHNESS_STATUS_LABELS[status]}</span>
      {contextStale && (
        <span
          className="rounded border border-risk-blocked/50 bg-risk-blocked/20 px-1 font-bold text-risk-blocked-foreground"
          // R-07：内联组合保留（含 border-blocked/50 变体，非标准 toneBadge 形状）
          title="活跃方案与统一调度上下文（/api/scheduler/context）版本不一致，可能展示混合版本数据"
        >
          上下文已过期
        </span>
      )}
      <span className="tabular-nums text-white/60">序号 {rt.lastSequence}</span>
      <span className="tabular-nums text-white/60" title="最近事件时间">
        {lastTime}
      </span>
      {context ? (
        <span
          className="tabular-nums text-white/60"
          title={`统一调度上下文：截至 ${context.sourceTimestamp} · 快照 v${context.snapshotVersion} · 资源 v${context.resourceVersion} · 路由图 v${context.routeGraphVersion} · 策略 v${context.policyVersion}`}
        >
          S{context.snapshotVersion} R{context.resourceVersion} G{context.routeGraphVersion} P{context.policyVersion}
        </span>
      ) : rt.snapshotVersion ? (
        <span className="text-white/60" title="快照版本">
          v{rt.snapshotVersion}
        </span>
      ) : null}
      {asOfTime && (
        <span className="tabular-nums text-white/60" title={`截至 ${context?.sourceTimestamp ?? ''}`}>
          截至 {asOfTime}
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
  // 返回按钮修复（2026-08-19）：原 window.history.back() 在无历史栈（直接 URL
  // 进入）或从外部跳转进入时无响应/离开应用——改为显式导航到指挥中心主页。
  const navigate = useNavigate();
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
  const setReplayTimestamp = ctl.setReplayTimestamp;
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
  // 审计 C12（2026-08-19）：REPLAN dry-run 预览（SchedulePanel 上抛 → 地图
  // changed-by-replan 图层；原实现图层开关存在但数据永远到不了地图）。
  const [replanPreview, setReplanPreview] = useState<ReplanPreviewResult | null>(null);
  // Phase 3 / P3-T3：聚合状态 Hook（React Query 权威数据 + SSE 增量 + 本地 UI state）。
  const schedulerState = useCommandMapSchedulerState();
  // 当前选中方案由 store 唯一真源 selectedPlanId 派生：无效/缺失 → null
  // （controller 对照权威 plans 校验），绝不回退首个方案。
  const activePlan = ctl.activePlan;
  // P1-D：统一调度上下文（版本边界 + dataQuality）+ 上下文已过期 判定。
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
  const helpDialogRef = useRef<HTMLDivElement>(null);
  const helpPreviousFocusRef = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();

  // 大脑建议数量（供面板区提示「N 条 AI 建议待查看」，与 BrainPanel 同源缓存）。
  const { data: brainSuggestions } = useQuery({
    queryKey: ['brain-suggestions'],
    queryFn: getBrainSuggestions,
    refetchInterval: 10000,
  });
  const brainCount = (brainSuggestions ?? []).length;

  // CLI-004 拆分：全部事实源查询移至 hooks/useCommandMapQueries（机械提取）。
  const {
    entitiesQuery,
    worldQuery,
    overviewQuery,
    replayQuery,
    environmentQuery,
    organizationsQuery,
    personnelQuery,
    devicesQuery,
    eventsQuery,
    routeGraphQuery,
    candidatesQuery,
    failedQueries,
  } = useCommandMapQueries({ replayMode, selectedTaskId, mode });

  const entities = entitiesQuery.data;
  const worldState = worldQuery.data;
  const worldUpdatedAt = worldQuery.dataUpdatedAt;
  const overview = overviewQuery.data;
  const replaySnapshots = replayQuery.data;
  const replayLoading = replayQuery.isLoading;
  const replayError = replayQuery.isError;
  const environmentReadings = environmentQuery.data;
  const organizations = organizationsQuery.data;
  const personnel = personnelQuery.data;
  const devices = devicesQuery.data;
  const devicesUpdatedAt = devicesQuery.dataUpdatedAt;
  const events = eventsQuery.data;
  const routeGraph = routeGraphQuery.data;
  const candidates = candidatesQuery.data;

  // 离开调度模式或清空方案时，重置任务选择与驾驶舱面板（store 唯一真源写入）。
  useEffect(() => {
    if (mode !== 'scheduling') {
      if (ctl.selectedTaskId) ctl.selectTask(null);
      setShowIntelligence(false);
    }
  }, [mode, ctl.selectedTaskId, ctl.selectTask]);
  // 默认方案采用（2026-08-20 决策驾驶舱可用性修复）：用户点选任务但从未选择
  // 方案时 selectedPlanId 恒 null → activePlan 恒 null → 下方"无方案清任务"
  // effect 会立即清掉刚选的任务 → 决策驾驶舱永远空态（无任何互动元素）。
  // 改为：存在活跃方案且未显式选择时，默认采用最新一个（API 按 createdAt DESC
  // 返回，plans[0] 即最新）。显式选择/冲突预览/对比流程不受影响（planId 非空
  // 跳过）；真正无任何活跃方案时保留原清任务语义。
  useEffect(() => {
    if (!ctl.selectedPlanId && ctl.scheduler.plans.length > 0) {
      ctl.selectPlan(ctl.scheduler.plans[0].planId);
    }
  }, [ctl.selectedPlanId, ctl.scheduler.plans, ctl.selectPlan]);
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

  // 真实回放播放循环：按倍速逐快照推进。
  // 2026-08-20 二修：推进必须用 setReplayTimestamp（只更新时间戳、不置 paused）。
  // 旧实现复用了 setReplayTime（拖动时间轴语义，设时间即 paused:true）→ 每推进
  // 一帧 paused 被置 true → effect 因 paused 变化清理 interval → 永远只动一帧
  // 就「自动暂停」；且起点分支 return 后依赖数组无变化，interval 根本不会被创建。
  // 现改为单一 interval：首 tick 用 advanceReplayTime(null) 取最旧帧为起点，
  // 后续 tick 逐帧推进，到最新帧循环回开头连续播放。
  useEffect(() => {
    if (!replayMode || replayPaused || !replaySnapshots?.length) return;
    const timer = window.setInterval(() => {
      const next = advanceReplayTime(replaySnapshots, replayTimeRef.current);
      if (next === replayTimeRef.current) return; // 单帧数据时避免无意义更新
      replayTimeRef.current = next;
      setReplayTimestamp(next);
    }, Math.max(200, 1000 / replaySpeed));
    return () => window.clearInterval(timer);
  }, [replayMode, replayPaused, replaySpeed, replaySnapshots, setReplayTimestamp]);

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
            // CLI-006：精确匹配（includes 会误命中 EXO-1 / EXO-10 前缀重叠）。
            const entity = list.find(
              (e) => e.entityType === 'device' && e.entityId === evt.deviceId,
            );
            if (entity) setSelectedEntityId(entity.entityId);
          }
      })
        .catch((err: unknown) => {
          // CLI-005：不再静默吞错（定位非关键路径，记日志不打断主流程）。
          logger.warn('focusEventEntity: 加载事件失败，无法定位关联设备', { eventId, err });
        });
    },
    [entities],
  );

  // ---- Task 9 / 9.1：URL 背书的操作上下文（镜像 ⇄ 恢复；深链聚焦）----
  // CLI-004 拆分：镜像/恢复编排移至 hooks/useCommandMapUrlSync（机械提取）。
  // 写规则：一律 history.replaceState——mode/level/selection/tab/冲突/事件/回放
  // 时间戳/compare 均属连续变化，不入历史栈；瞬态 UI（对话框/动画/抽屉）不镜像。
  const isValidUrlTab = useCallback((tab: string) => TABS.some((t) => t.key === tab), []);
  const { notices: urlNotices, dismissNotice: dismissUrlNotice } = useCommandMapUrlSync({
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
    isValidTab: isValidUrlTab,
    ready: !schedulerState.loading,
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
      document.documentElement
        .requestFullscreen?.()
        .then(() => setIsFullscreen(true))
        .catch((err: unknown) => {
          // CLI-008：不再静默吞错（浏览器策略拒绝等场景记日志）。
          logger.warn('requestFullscreen 被拒绝', err);
        });
    } else {
      document.exitFullscreen
        ?.()
        .then(() => setIsFullscreen(false))
        .catch((err: unknown) => {
          logger.warn('exitFullscreen 失败', err);
        });
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
          queryClient.invalidateQueries({ queryKey: queryKeys.events() });
        })
        .catch((err) => {
          toast.error('处置失败', {
            description: errorDescription(err),
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

  /**
   * NO-16a：保存任务能力要求（能力模型唯一人工写入口的前端接线）。
   * 成功后失效候选查询：要求变了，候选集必须重算（否则面板还显示旧要求下的结论）。
   */
  const [requirementWarnings, setRequirementWarnings] = useState<string[]>([]);
  /** NO-20a：放宽高风险能力被闸门拦下时的现场提示（含服务端原因）。 */
  const [approvalRequired, setApprovalRequired] = useState<
    { message: string; relaxedHighRisk: string[] } | null
  >(null);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  /** NO-22a：任务侧审批的时效文案（"还有多久能用"，与设备侧同一 shared 实现）。 */
  const [pendingApprovalFreshness, setPendingApprovalFreshness] = useState<string | null>(null);
  const saveRequirementsMutation = useMutation({
    mutationFn: (params: {
      taskId: string;
      deviceNames: string[];
      stationNames: string[];
      approvalId?: string;
    }) =>
      updateTaskRequirements(params.taskId, {
        requiredDeviceCapabilities: params.deviceNames,
        requiredStationCapabilities: params.stationNames,
        ...(params.approvalId ? { approvalId: params.approvalId } : {}),
      }),
    onSuccess: (data, params) => {
      setRequirementWarnings(data.warnings ?? []);
      // 成功（含"经审批放行"）→ 清掉闸门提示与待用审批号
      setApprovalRequired(null);
      setPendingApprovalId(null);
      setPendingApprovalFreshness(null);
      if ((data.warnings ?? []).length > 0) {
        toast.warning('能力要求已保存，但当前无法匹配', {
          description: data.warnings.join('；'),
        });
      } else {
        toast.success('能力要求已保存', {
          description: '已触发重排：旧方案按旧要求计算，请重新生成/审批。',
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.schedulerTaskCandidates(params.taskId),
      });
    },
    onError: (err: unknown, params) => {
      // NO-20a：放宽高风险能力需安全管理员审批——把服务端原因与入口给到现场，
      // 而不是只弹一句"保存失败"。平台不会自动放宽，也不会替现场发起审批。
      if (isCapabilityRelaxationApprovalRequired(err)) {
        const message = errorText(err) || '放宽高风险能力需安全管理员审批';
        const relaxedHighRisk = relaxedHighRiskForSave(
          candidatesQuery.data ?? null,
          params.deviceNames,
        );
        setApprovalRequired({ message, relaxedHighRisk });
        toast.warning('需安全管理员审批', { description: message });
        return;
      }
      toast.error('能力要求保存失败', { description: errorDescription(err) });
    },
  });

  /** 发起"放宽高风险能力"的审批（由他人审批；现场随后粘贴审批号重试保存）。 */
  const requestApprovalMutation = useMutation({
    mutationFn: (params: { taskId: string; deviceNames: string[]; stationNames: string[] }) => {
      const relaxed = relaxedHighRiskForSave(candidatesQuery.data ?? null, params.deviceNames);
      return requestCapabilityRelaxationApproval({
        taskId: params.taskId,
        subject: buildRelaxationApprovalSubject({
          taskId: params.taskId,
          taskTitle: candidatesQuery.data?.taskTitle ?? null,
          relaxedHighRisk: relaxed,
          nextDeviceCapabilities: params.deviceNames,
          nextStationCapabilities: params.stationNames,
        }),
      });
    },
    onSuccess: (data) => {
      setPendingApprovalId(data.id);
      // 新建的审批还没有"通过时间"：如实显示"等待审批"，不假装有时效
      setPendingApprovalFreshness(describeCapabilityApprovalFreshness(data.approvedAt ?? null).label);
      toast.success('已发起安全审批', {
        description: `审批号 ${data.id}｜由安全管理员审批；获批后粘贴审批号再保存一次。`,
      });
    },
    onError: (err: unknown) => {
      toast.error('发起审批失败', { description: errorDescription(err) });
    },
  });

  /** 检查审批状态：已通过则提示可直接重试保存（不自动保存——改要求仍需人工确认）。 */
  const checkApproval = useCallback(async () => {
    if (!pendingApprovalId) return;
    try {
      const approval = await getApprovalStatus(pendingApprovalId);
      // NO-22a：时效如实展示——通过后按 24 小时有效期提示"还能用多久"
      setPendingApprovalFreshness(describeCapabilityApprovalFreshness(approval.approvedAt ?? null).label);
      if (approval.status === 'approved') {
        const freshness = describeCapabilityApprovalFreshness(approval.approvedAt ?? null);
        toast.success('审批已通过', {
          description: freshness.valid
            ? `请粘贴审批号后点击保存（平台不会自动代劳）。${freshness.label}`
            : `审批已通过但${freshness.label}：请重新申请审批后再保存。`,
        });
      } else {
        toast.info(`审批状态：${approval.status}`, { description: '等待安全管理员处理。' });
      }
    } catch (err) {
      toast.error('审批状态查询失败', { description: errorDescription(err) });
    }
  }, [pendingApprovalId]);

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
        description: errorDescription(error),
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
  // 方案对比（2026-08-20 可用性修复）：PlanCompareWorkspace 面板仅在调度模式
  // （mode === 'scheduling'）渲染——非调度模式下点击决策驾驶舱「方案对比」
  // 时原实现只 setShowCompare(true)，面板不出现，用户感知"点了没反应"。
  // 改为：先切到智能调度模式再打开对比面板。
  const handleOpenCompare = useCallback(() => {
    if (mode !== 'scheduling') setMode('scheduling');
    setShowCompare(true);
  }, [mode, setMode]);
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
        className="fixed inset-0 z-50 flex flex-col bg-surface-inverse text-white"
        data-inverse-surface=""
      >
      <a
        href="#command-map-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary focus:shadow-lg"
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
        onBack={() => navigate('/command-center')}
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
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-risk-degraded/40 bg-risk-degraded/10 px-3 py-2"
        >
          <TriangleAlert className="w-4 h-4 shrink-0 text-risk-degraded-foreground" />
          <span className="text-xs text-warning-foreground">
            {urlNotices.map((n) => n.message).join('；')}
          </span>
          <button
            type="button"
            onClick={() => urlNotices.forEach((_, i) => dismissUrlNotice(i))}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-risk-degraded-foreground/80 hover:bg-risk-degraded/10"
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
          onSaveRequirements={(taskId, deviceNames, stationNames, approvalId) =>
            saveRequirementsMutation.mutate({ taskId, deviceNames, stationNames, approvalId })
          }
          savingRequirements={saveRequirementsMutation.isPending}
          requirementWarnings={requirementWarnings}
          approvalRequired={approvalRequired}
          onRequestApproval={(taskId, deviceNames, stationNames) =>
            requestApprovalMutation.mutate({ taskId, deviceNames, stationNames })
          }
          pendingApprovalId={pendingApprovalId}
          pendingApprovalFreshness={pendingApprovalFreshness}
          onRefreshApproval={() => void checkApproval()}
          visibleBounds={ctl.viewportBounds}
          onVisibleBoundsChange={ctl.setViewportBounds}
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
          replanPreview={replanPreview}
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
          'shrink-0 flex flex-col bg-surface-inverse border-t border-white/10',
          panelExpanded ? 'h-[60vh]' : 'h-[260px] lg:h-[320px]',
        )}
      >
        <div className="flex items-center gap-1 px-3 h-9 border-b border-white/10 bg-surface-inverse-raised overflow-x-auto">
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
                    ? 'bg-card/10 text-white'
                    : 'text-white/70 hover:text-white/80 hover:bg-card/5',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
          {/* 大脑建议快捷入口：非 brain 面板且有建议时提示，点击直达 */}
          {activeTab !== 'brain' && brainCount > 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('brain')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium text-primary-on-soft bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-colors whitespace-nowrap"
              title="查看并采纳 AI 生成的调度建议"
            >
              <Brain className="w-3 h-3 text-primary" />
              {brainCount} 条 AI 建议待查看
            </button>
          )}
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
              onReplanPreviewChange={setReplanPreview}
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

      {/* 快捷键帮助浮层（CLI-038：Tab 焦点陷阱，防焦点逃出对话框） */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={() => setShowHelp(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcut-help-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setShowHelp(false);
              return;
            }
            if (event.key === 'Tab') {
              const dialog = helpDialogRef.current;
              if (!dialog) return;
              const focusables = Array.from(
                dialog.querySelectorAll<HTMLElement>(
                  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
                ),
              );
              if (focusables.length === 0) return;
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              const active = document.activeElement;
              if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        >
          <div
            ref={helpDialogRef}
            className="bg-surface-inverse-raised border border-white/10 rounded-xl p-6 shadow-2xl min-w-[320px]"
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
                  <kbd className="px-2 py-0.5 bg-card/10 rounded text-xs text-white font-mono min-w-[40px] text-center">
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
