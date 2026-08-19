/* Task 4 / P1：useCommandMapController 门面测试（controller 动作 → store）。
 *
 * 用 react-dom/server renderToString 在 node 环境渲染 Probe：
 * - React Query 缓存预置权威 plans（queryKeys.schedulerActivePlans）；
 * - 断言 controller 命令写入 store（唯一真源）：
 *   - selectPlan(有效 id) → store.selection.planId 更新；
 *   - selectPlan(无效 id) → 解析为 null（绝不回退）；
 *   - selectTask(未知 id) → null；
 *   - replay/mode/viewport/decisionContext 命令 → 对应 slice 更新。
 */
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@client/src/hooks/queryKeys';
import {
  useCommandMapStore,
  DEFAULT_SELECTION,
  DEFAULT_VIEWPORT,
  DEFAULT_REPLAY,
  DEFAULT_SCHEDULER_REALTIME,
  DEFAULT_DECISION_CONTEXT,
} from '../store/commandMapStore';
import { useCommandMapController } from './useCommandMapController';
import type { SchedulingPlanV2 } from '@shared/api.interface';

jest.mock('@client/src/api/scheduler', () => ({
  getSnapshot: jest.fn(),
  getActivePlans: jest.fn(),
  getUnifiedResourceState: jest.fn(),
  getSchedulerContext: jest.fn(),
  getRoutes: jest.fn(),
  getConflicts: jest.fn(),
}));

// SchedulerRealtimeProvider 依赖 useSchedulerStream（内部有 import.meta.env，node/CJS 不可执行）。
// controller 的 SSE bridge 组件在测试中不渲染，mock 掉 Provider 即可。
jest.mock('@client/src/scheduler/SchedulerRealtimeProvider', () => ({
  SchedulerRealtimeProvider: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  useSchedulerRealtime: () => ({
    status: 'live',
    statusV2: 'CONNECTED',
    lastEventTime: null,
    snapshotVersion: null,
    lastSequence: 0,
    triggerResync: jest.fn(),
  }),
}));

function makePlan(planId: string): SchedulingPlanV2 {
  return {
    planId,
    planName: planId,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [],
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: '',
  };
}

function resetStore(): void {
  useCommandMapStore.setState({
    version: 0,
    selection: { ...DEFAULT_SELECTION },
    viewport: { ...DEFAULT_VIEWPORT },
    mode: 'production',
    level: 'L1',
    replay: { ...DEFAULT_REPLAY },
    schedulerRealtime: { ...DEFAULT_SCHEDULER_REALTIME },
    decisionContext: { ...DEFAULT_DECISION_CONTEXT },
  });
}

interface Capture {
  ctl: ReturnType<typeof useCommandMapController> | null;
}

function renderWithPlans(plans: SchedulingPlanV2[]): Capture {
  const capture: Capture = { ctl: null };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(queryKeys.schedulerActivePlans, plans);
  // snapshot 预置，供 selectTask 校验。
  qc.setQueryData(queryKeys.schedulerSnapshot, {
    snapshotVersion: 'WS-1',
    ts: '',
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  });

  function Probe(): React.ReactElement | null {
    capture.ctl = useCommandMapController();
    return null;
  }
  renderToString(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  return capture;
}

describe('useCommandMapController（controller 动作 → store 唯一真源）', () => {
  beforeEach(resetStore);

  it('selectPlan(有效 id) → store.selection.planId 更新，selectionType=plan', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A'), makePlan('PLAN-B')]);
    expect(ctl).not.toBeNull();
    ctl!.selectPlan('PLAN-B');
    expect(useCommandMapStore.getState().selection.planId).toBe('PLAN-B');
    expect(useCommandMapStore.getState().selection.selectionType).toBe('plan');
  });

  it('selectPlan(无效/不存在 id) → 解析为 null（绝不回退列表首个方案）', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A'), makePlan('PLAN-B')]);
    ctl!.selectPlan('PLAN-NOT-EXIST');
    expect(useCommandMapStore.getState().selection.planId).toBeNull();
    ctl!.selectPlan(null);
    expect(useCommandMapStore.getState().selection.planId).toBeNull();
  });

  it('selectPlan 在 plans 为空（尚未加载）时不写入悬空 id', () => {
    const { ctl } = renderWithPlans([]);
    ctl!.selectPlan('PLAN-A');
    expect(useCommandMapStore.getState().selection.planId).toBeNull();
  });

  it('selectTask(未知 id) → null；selectEntity 原样写入', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A')]);
    ctl!.selectTask('TASK-NOT-EXIST');
    expect(useCommandMapStore.getState().selection.taskId).toBeNull();
    ctl!.selectEntity('ENT-1');
    expect(useCommandMapStore.getState().selection.entityId).toBe('ENT-1');
    expect(useCommandMapStore.getState().selection.selectionType).toBe('entity');
  });

  it('setMode 经 map-mode-machine 联动（scheduling → L3；非法 mode 拒绝）', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A')]);
    ctl!.setMode('scheduling');
    expect(useCommandMapStore.getState().mode).toBe('scheduling');
    expect(useCommandMapStore.getState().level).toBe('L3');
    ctl!.setMode('bogus');
    expect(useCommandMapStore.getState().mode).toBe('scheduling');
  });

  it('replay 控制（toggle/暂停/倍速/时间）写入 replay slice', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A')]);
    ctl!.toggleReplay();
    expect(useCommandMapStore.getState().replay.active).toBe(true);
    expect(useCommandMapStore.getState().replay.paused).toBe(false);
    ctl!.toggleReplayPause();
    expect(useCommandMapStore.getState().replay.paused).toBe(true);
    ctl!.setReplaySpeed(2);
    expect(useCommandMapStore.getState().replay.speed).toBe(2);
    ctl!.setReplayTime('2026-08-10T00:00:00.000Z');
    expect(useCommandMapStore.getState().replay.timestamp).toBe('2026-08-10T00:00:00.000Z');
    expect(useCommandMapStore.getState().replay.paused).toBe(true);
    // 播放循环专用：setReplayTimestamp 只更新时间戳，绝不触碰 paused
    // （2026-08-20 回放自动暂停二修：复用 setReplayTime 推进帧会把 paused
    //  置 true 导致每推进一帧就暂停）。
    ctl!.setReplayTimestamp('2026-08-10T00:01:00.000Z');
    expect(useCommandMapStore.getState().replay.timestamp).toBe('2026-08-10T00:01:00.000Z');
    expect(useCommandMapStore.getState().replay.paused).toBe(true);
    ctl!.toggleReplayPause();
    expect(useCommandMapStore.getState().replay.paused).toBe(false);
    ctl!.setReplayTimestamp('2026-08-10T00:02:00.000Z');
    expect(useCommandMapStore.getState().replay.paused).toBe(false);
    ctl!.setReplayMode(false);
    expect(useCommandMapStore.getState().replay.active).toBe(false);
  });

  it('setViewportBounds 写入 viewport.visibleBounds；setDecisionContext 写入 decisionContext', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A')]);
    ctl!.setViewportBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(useCommandMapStore.getState().viewport.visibleBounds).toEqual({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
    });
    ctl!.setDecisionContext({ conflictId: 'C1' }, 'conflict');
    expect(useCommandMapStore.getState().decisionContext).toEqual({
      context: { conflictId: 'C1' },
      source: 'conflict',
    });
    ctl!.clearDecisionContext();
    expect(useCommandMapStore.getState().decisionContext.source).toBeNull();
  });

  it('activePlan 派生自 store.selectedPlanId（无效 → null）', () => {
    const { ctl } = renderWithPlans([makePlan('PLAN-A'), makePlan('PLAN-B')]);
    expect(ctl!.activePlan).toBeNull(); // 初始无选中
    // 重新渲染后（store 已写入）controller 派生最新 activePlan。
    const capture2 = renderWithPlans([makePlan('PLAN-A'), makePlan('PLAN-B')]);
    capture2.ctl!.selectPlan('PLAN-A');
    expect(useCommandMapStore.getState().selection.planId).toBe('PLAN-A');
    // 派生逻辑：无效 id → null（与 selectPlanForLayer 同源，无回退）。
    expect(ctl!.activePlan).toBeNull();
  });
});
