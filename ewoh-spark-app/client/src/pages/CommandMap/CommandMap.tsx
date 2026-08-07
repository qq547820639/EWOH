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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { getEntities } from '../../api/spatial';
import { createReplayItem, getReplay, getWorldState } from '../../api/world';
import {
  getOverview,
  getEvents,
  handleEvent,
  getEnvironmentSummary,
  searchDevices,
} from '../../api/dashboard';
import { listOrganizations, listPersonnel } from '../../api/organization';
import type {
  SpatialEntity,
  CurrentWorldState,
  OverviewStats,
  ReplaySnapshot,
  EnvironmentReading,
  DeviceInfo,
  EventInfo,
  OrganizationInfo,
  PersonnelInfo,
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
import FactoryMap from './FactoryMap';
import EntityDetail from './EntityDetail';
import AlertToast from '../../components/AlertToast';
import DataStates from '../../components/DataStates';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { UI_ARIA_LABELS } from '../../lib/a11y';
import {
  collectQueryErrors,
  retryAll,
  type QueryStateSnapshot,
} from './queryState';

// 按需懒加载 (Task 9 代码分割)：各底部面板仅在对应标签激活时渲染。
// React.lazy 将重/低频组件拆分为独立 chunk，降低 CommandMap 主 chunk 的传载体积。
const TimelinePanel = React.lazy(() => import('./panels/TimelinePanel'));
const EventCenterPanel = React.lazy(() => import('./panels/EventCenterPanel'));
const SchedulePanel = React.lazy(() => import('./panels/SchedulePanel'));
const WorkbenchPanel = React.lazy(() => import('./panels/WorkbenchPanel'));
const ResourcePoolPanel = React.lazy(() => import('./panels/ResourcePoolPanel'));
const TaskOrchestrationPanel = React.lazy(() => import('./panels/TaskOrchestrationPanel'));
const BrainPanel = React.lazy(() => import('./panels/BrainPanel'));

/** 懒加载 chunk 加载期间的轻量占位，避免空白闪烁。 */
const MapPanelFallback = () => (
  <div className="flex h-full w-full items-center justify-center text-xs text-white/50">
    加载中…
  </div>
);

interface TabItem {
  key: string;
  label: string;
  icon: LucideIcon;
}

const TABS: TabItem[] = [
  { key: 'timeline', label: '时间轴', icon: Clock },
  { key: 'events', label: '事件中心', icon: AlertCircle },
  { key: 'schedule', label: '调度方案', icon: GitBranch },
  { key: 'workbench', label: '班组长工作台', icon: Hammer },
  { key: 'resource', label: '资源池', icon: Users },
  { key: 'orchestration', label: '任务编排', icon: Workflow },
  { key: 'brain', label: '大脑建议', icon: Brain },
];

const MODES = [
  'production',
  'person',
  'exoskeleton',
  'body_load',
  'safety_risk',
  'device',
  'environment',
  'scheduling',
  'data_quality',
];

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

const NO_ENVIRONMENT_READINGS: EnvironmentReading[] = [];

const CommandMap = (): React.ReactElement => {
  const [mode, setMode] = useState<string>('production');
  const [level, setLevel] = useState<'L0' | 'L1' | 'L2' | 'L3' | 'L4'>('L1');
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('timeline');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [replayMode, setReplayMode] = useState(false);
  const [replayPaused, setReplayPaused] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayTime, setReplayTime] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const replayTimeRef = useRef<string | null>(null);
  const handledUrlEventRef = useRef<string | null>(null);
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

  const { data: devices } = useQuery<DeviceInfo[]>({
    queryKey: queryKeys.devices({ pageSize: 200 }),
    queryFn: () => searchDevices({ pageSize: 200 }),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const { data: events } = useQuery<EventInfo[]>({
    queryKey: queryKeys.events(),
    queryFn: () => getEvents(200),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const entityList = entities ?? [];
  const state = worldState ?? null;

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
      setReplayTime((prev) => {
        const next = advanceReplayTime(replaySnapshots, prev);
        replayTimeRef.current = next;
        return next;
      });
    }, Math.max(200, 1000 / replaySpeed));
    return () => window.clearInterval(timer);
  }, [replayMode, replayPaused, replaySpeed, replaySnapshots]);

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

  // 飞书闭环：读取 URL event_id 参数（H2）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('event_id');
    if (eventId && handledUrlEventRef.current !== eventId) {
      handledUrlEventRef.current = eventId;
      focusEventEntity(eventId);
    }
  }, [focusEventEntity]);

  // 层级循环 L0 → L1 → L2 → L3 → L4 → L0
  const handleLevelToggle = useCallback(() => {
    setLevel((prev) =>
      prev === 'L0' ? 'L1' : prev === 'L1' ? 'L2' : prev === 'L2' ? 'L3' : prev === 'L3' ? 'L4' : 'L0',
    );
  }, []);

  // 回放切换
  const handleReplayToggle = useCallback(() => {
    setReplayMode((prev) => {
      const next = !prev;
      if (next) {
        setReplayPaused(false);
        setReplayTime(null);
      }
      return next;
    });
  }, []);

  // 空格：暂停/继续回放；未进入回放时先进入
  const handleReplayPauseToggle = useCallback(() => {
    setReplayMode((prev) => {
      if (!prev) {
        setReplayPaused(false);
        setReplayTime(null);
        return true;
      }
      setReplayPaused((p) => !p);
      return true;
    });
  }, []);

  const handleReplayModeChange = useCallback((next: boolean) => {
    setReplayMode(next);
    if (next) {
      setReplayPaused(false);
      setReplayTime(null);
    }
  }, []);

  const handleReplayTimeChange = useCallback((time: string | null) => {
    setReplayTime(time);
    if (time) setReplayPaused(true);
  }, []);

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

  return (
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
        <ModePanel mode={mode} onModeChange={setMode} level={level} onLevelChange={setLevel} />

        <FactoryMap
          entities={entityList}
          worldState={displayWorldState}
          environmentReadings={environmentReadings ?? []}
          mode={mode}
          level={level}
          selectedEntityId={selectedEntityId}
          onSelectEntity={setSelectedEntityId}
          replayMode={replayMode}
          replayTime={replayTime}
        />

        <EntityDetail
          entityId={selectedEntityId}
          entities={entityList}
          worldState={displayWorldState}
          personnel={personnel ?? []}
          organizations={organizations ?? []}
          devices={devices ?? []}
          events={events ?? []}
          onOpenDisposition={(eventId) => {
            setActiveTab('events');
            setSelectedEventId(eventId);
          }}
          onClose={() => setSelectedEntityId(null)}
        />

        {/* 小屏模式/层级控件 */}
        <div className="absolute left-2 top-2 z-30 flex max-w-[calc(100%-1rem)] items-center gap-1.5 md:hidden">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className="h-8 max-w-[150px] rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 px-2 text-xs text-white outline-none"
            aria-label="切换地图模式"
          >
            {MODE_ITEMS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="flex gap-0.5 rounded-md border border-white/10 bg-[hsl(220_14%_14%)]/95 p-0.5">
            {(['L0', 'L1', 'L2', 'L3', 'L4'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                aria-pressed={level === l}
                aria-label={`切换到${l}层级`}
                className={`h-7 min-w-7 rounded px-1 text-[10px] font-medium ${
                  level === l ? 'bg-[hsl(221_83%_53%)] text-white' : 'text-white/60'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 底部标签栏 + 面板区 */}
      <div className="h-[220px] shrink-0 flex flex-col bg-[hsl(220_14%_12%)] border-t border-white/10 lg:h-[280px]">
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
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'timeline' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <TimelinePanel
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
            </React.Suspense>
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
            <React.Suspense fallback={<MapPanelFallback />}>
              <SchedulePanel />
            </React.Suspense>
          )}
          {activeTab === 'workbench' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <WorkbenchPanel
                onNavigate={setActiveTab}
                onModeChange={setMode}
                onSelectEntity={setSelectedEntityId}
              />
            </React.Suspense>
          )}
          {activeTab === 'resource' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <ResourcePoolPanel entities={entityList} worldState={state} />
            </React.Suspense>
          )}
          {activeTab === 'orchestration' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <TaskOrchestrationPanel
                entities={entityList}
                onOpenSchedule={() => setActiveTab('schedule')}
              />
            </React.Suspense>
          )}
          {activeTab === 'brain' && (
            <React.Suspense fallback={<MapPanelFallback />}>
              <BrainPanel />
            </React.Suspense>
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
    </div>
  );
};

export default CommandMap;
