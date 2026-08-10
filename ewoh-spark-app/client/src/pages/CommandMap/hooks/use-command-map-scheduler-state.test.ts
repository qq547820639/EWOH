/* Phase 3 / P3-T3：useCommandMapSchedulerState 纯选择器测试。
 *
 * buildCommandMapState 为纯函数（node 可测）：聚合 React Query 各查询结果 +
 * UI state → 展示模型。不重算资格/成本（透传后端字段）。
 */
import { applyUiPatch, buildCommandMapState, DEFAULT_UI_STATE } from './commandMapSelector';
import type { WorldStateSnapshot, SchedulingPlanV2, ResourceState } from '@shared/api.interface';

const SNAPSHOT: WorldStateSnapshot = {
  snapshotVersion: 'WS-1',
  ts: '2026-08-09T00:00:00.000Z',
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
};

describe('buildCommandMapState（聚合选择器）', () => {
  it('聚合查询结果 + UI state（冲突经 conflictVM 分组）', () => {
    const state = buildCommandMapState({
      snapshot: SNAPSHOT,
      resources: [{ id: 'p1', type: 'person', status: 'available', capabilities: [], certifications: [], location: { stationId: null, zoneId: null, x: 0, y: 0 }, availableWindows: [], reservations: [], telemetry: {}, version: 1 } as ResourceState],
      plans: [{ planId: 'P1', planName: '方案A', version: 1, status: 'shadow', trigger: { type: 'MANUAL', entityId: null }, snapshotVersion: 'WS-1', assignments: [], metrics: {}, baselineDelta: {}, violations: [], createdAt: '' } as unknown as SchedulingPlanV2],
      routes: null,
      conflicts: [
        {
          conflictId: 'CFL-1', type: 'device_offline', severity: 'high', scope: 'resource',
          resourceId: 'd1', resourceType: 'device', taskIds: [], message: '离线', resolution: null,
          createdAt: '', snapshotVersion: 'CURRENT', status: 'OPEN',
        },
      ],
      ui: { ...DEFAULT_UI_STATE, selectedTaskId: 't1', activeLayers: ['conflict'], panelMode: 'conflict' },
      loading: false,
      hasError: false,
    });
    expect(state.snapshot?.snapshotVersion).toBe('WS-1');
    expect(state.resources).toHaveLength(1);
    expect(state.plans[0].planId).toBe('P1');
    expect(state.conflicts.total).toBe(1);
    expect(state.conflicts.openCount).toBe(1);
    expect(state.ui.selectedTaskId).toBe('t1');
    expect(state.ui.activeLayers).toContain('conflict');
    expect(state.loading).toBe(false);
    expect(state.hasError).toBe(false);
  });

  it('查询数据缺失 → 安全降级（空数组/null，不抛错不虚构）', () => {
    const state = buildCommandMapState({
      snapshot: null,
      resources: undefined,
      plans: undefined,
      routes: undefined,
      conflicts: undefined,
      ui: DEFAULT_UI_STATE,
      loading: true,
      hasError: true,
    });
    expect(state.snapshot).toBeNull();
    expect(state.resources).toEqual([]);
    expect(state.plans).toEqual([]);
    expect(state.routes).toBeNull();
    expect(state.conflicts.total).toBe(0);
    expect(state.loading).toBe(true);
    expect(state.hasError).toBe(true);
  });
});

describe('applyUiPatch（updateUi 底层合并，selection owner）', () => {
  it('局部 patch 更新指定 ui 字段，其余字段原样保留', () => {
    const prev: Parameters<typeof applyUiPatch>[0] = {
      ...DEFAULT_UI_STATE,
      selectedTaskId: 't1',
      activeLayers: ['conflict'],
    };
    const next = applyUiPatch(prev, { selectedPlanId: 'P2' });
    expect(next.selectedPlanId).toBe('P2');
    expect(next.selectedTaskId).toBe('t1');
    expect(next.activeLayers).toEqual(['conflict']);
    expect(next).not.toBe(prev);
  });

  it('面板选方案 → updateUi 更新 selectedPlanId（无选中 → 选中）', () => {
    const next = applyUiPatch({ ...DEFAULT_UI_STATE }, { selectedPlanId: 'PLAN-B' });
    expect(next.selectedPlanId).toBe('PLAN-B');
  });

  it('地图选任务 → ui.selectedTaskId 更新', () => {
    const next = applyUiPatch({ ...DEFAULT_UI_STATE }, { selectedTaskId: 'TASK-1' });
    expect(next.selectedTaskId).toBe('TASK-1');
  });

  it('取消/清空选中 → 字段显式置 null（不保留旧值）', () => {
    const next = applyUiPatch(
      { ...DEFAULT_UI_STATE, selectedPlanId: 'PLAN-A', selectedTaskId: 'TASK-1' },
      { selectedPlanId: null },
    );
    expect(next.selectedPlanId).toBeNull();
    expect(next.selectedTaskId).toBe('TASK-1');
  });
});
