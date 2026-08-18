/* Task 2（scheduler-phase0-truth-context / P0-2）：SchedulingContext 统一上下文单测。
 *
 * 覆盖：context 组装（版本字段非空且来自对应 mock）、org 过滤（mock 服务按 org 返回）、
 * dataQuality 汇总正确、sourceTimestamp=snapshot.ts。
 *
 * 遵循 dispatch-test-harness / constraint-run-loading 的 mock 风格：全部依赖以 jest.fn 注入，
 * 不触数据库。
 */
/// <reference types="jest" />
import { SchedulingContextService } from '../scheduling-context.service';
import type { OrgContext } from '../../shared/org-context.interceptor';
import type {
  ResourceState,
  SchedulingConstraint,
  WorldStateSnapshot,
} from '@shared/api.interface';

function makeSnapshot(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-20260810-0007',
    ts: '2026-08-10T08:00:00.000Z',
    worldVersion: 4321,
    entityVersions: { 'task:t1': 3 },
    reservations: [
      { reservationId: 'R1', resourceId: 'p1', resourceType: 'person', startMs: 100, endMs: 200 },
    ],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
    persons: [],
    tasks: [
      {
        id: 't1',
        title: '搬运',
        taskType: 'material_handling',
        priority: 'high',
        status: 'pending',
        assigneeId: null,
        deviceId: null,
        stationId: 'S-1',
        zoneId: null,
        planStart: null,
        planEnd: null,
        progress: 0,
        predecessorIds: [],
        requiredSkills: [],
        requiredCertifications: [],
      },
    ],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [
      { edgeId: 'e1', status: 'open', riskLevel: null },
      { edgeId: 'e2', status: 'blocked', riskLevel: 'high' },
      { edgeId: 'e3', status: 'congested', riskLevel: 'medium' },
    ],
    forbiddenZones: [],
    lockedAssignments: [],
    ...overrides,
  };
}

function makeResources(): ResourceState[] {
  return [
    // STALE 且位置未知
    {
      id: 'p1',
      type: 'person',
      status: 'UNKNOWN',
      capabilities: [],
      certifications: [],
      location: { stationId: null, zoneId: null, x: null, y: null },
      availableWindows: [],
      reservations: [],
      telemetry: { batteryPct: null, loadLevel: null, fatigueLevel: null, healthStatus: null },
      dataQuality: 'STALE',
      version: 1,
    },
    // FRESH 但有坐标
    {
      id: 'd1',
      type: 'device',
      status: 'AVAILABLE',
      capabilities: [],
      certifications: [],
      location: { stationId: 'S-1', zoneId: null, x: 10, y: 20 },
      availableWindows: [],
      reservations: [],
      telemetry: { batteryPct: 80, loadLevel: null, fatigueLevel: null, healthStatus: null },
      dataQuality: 'FRESH',
      version: 1,
    },
    // STALE 但有 stationId（只计入 stale，不计 unknown location）
    {
      id: 's1',
      type: 'station',
      status: 'UNKNOWN',
      capabilities: [],
      certifications: [],
      location: { stationId: 's1', zoneId: null, x: null, y: null },
      availableWindows: [],
      reservations: [],
      telemetry: { batteryPct: null, loadLevel: null, fatigueLevel: null, healthStatus: null },
      dataQuality: 'STALE',
      version: 1,
    },
  ];
}

function makeConstraints(): SchedulingConstraint[] {
  return [
    { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p1', orgId: 'org1' },
    { type: 'EXCLUDED_RESOURCE', deviceId: 'd9', orgId: 'org1' },
  ];
}

function makeSvc() {
  const worldStateSnapshotService = {
    buildSnapshot: jest.fn(),
    // 2026-08-19 优化：context 读路径改走只读快照（不分配版本号、不 INSERT），
    // mock 同步补齐（原缺该方法是本 spec 5 例失败的根因）。
    buildSnapshotReadOnly: jest.fn(),
    getCurrentWorldState: jest.fn(),
  };
  const resourceProjectionService = { getUnifiedResourceState: jest.fn(), project: jest.fn() };
  const policyService = { getActivePolicy: jest.fn() };
  const outboxService = { latestSequence: jest.fn() };
  const constraintLoaderService = { loadGlobalActive: jest.fn() };

  const svc = new SchedulingContextService(
    worldStateSnapshotService as never,
    resourceProjectionService as never,
    policyService as never,
    outboxService as never,
    constraintLoaderService as never,
  );
  return { svc, mocks: { worldStateSnapshotService, resourceProjectionService, policyService, outboxService, constraintLoaderService } };
}

const orgCtx: OrgContext = {
  userId: 'u1',
  primaryOrgId: 'org1',
  accessibleOrgIds: ['org1'],
  isGlobalAdmin: false,
};

describe('P0-2: SchedulingContextService.getContext 统一上下文组装', () => {
  it('版本字段真实取值（snapshot/resource/routeGraph/policy/eventSequence/sourceTimestamp）', async () => {
    const { svc, mocks } = makeSvc();
    const snapshot = makeSnapshot();
    mocks.worldStateSnapshotService.buildSnapshotReadOnly.mockResolvedValue(snapshot);
    mocks.resourceProjectionService.getUnifiedResourceState.mockResolvedValue(makeResources());
    mocks.policyService.getActivePolicy.mockResolvedValue({ version: 7 } as never);
    mocks.outboxService.latestSequence.mockResolvedValue(42);
    mocks.constraintLoaderService.loadGlobalActive.mockResolvedValue(makeConstraints());

    const ctx = await svc.getContext(orgCtx);

    expect(ctx.snapshotVersion).toBe('WS-20260810-0007');
    // 无独立 resource/route graph 版本号 → 以 snapshot.worldVersion 字符串化为代理（真实值，非伪造）。
    expect(ctx.resourceVersion).toBe('4321');
    expect(ctx.routeGraphVersion).toBe('4321');
    expect(ctx.policyVersion).toBe(7);
    expect(ctx.eventSequence).toBe(42);
    expect(ctx.sourceTimestamp).toBe('2026-08-10T08:00:00.000Z');
  });

  it('tasks/resources/reservations/constraints 来自对应 mock 源（单一时间切片）', async () => {
    const { svc, mocks } = makeSvc();
    const snapshot = makeSnapshot();
    mocks.worldStateSnapshotService.buildSnapshotReadOnly.mockResolvedValue(snapshot);
    mocks.resourceProjectionService.getUnifiedResourceState.mockResolvedValue(makeResources());
    mocks.policyService.getActivePolicy.mockResolvedValue({ version: 7 } as never);
    mocks.outboxService.latestSequence.mockResolvedValue(42);
    mocks.constraintLoaderService.loadGlobalActive.mockResolvedValue(makeConstraints());

    const ctx = await svc.getContext(orgCtx);

    expect(ctx.tasks).toEqual(snapshot.tasks);
    expect(ctx.reservations).toEqual(snapshot.reservations);
    expect(ctx.resources).toHaveLength(3);
    expect(ctx.resources[0].dataQuality).toBe('STALE');
    expect(ctx.constraints).toHaveLength(2);
    expect(ctx.constraints[0].type).toBe('LOCKED_PERSON');
  });

  it('org 过滤：buildSnapshot 与 loadGlobalActive 收到归一化后的 org 上下文', async () => {
    const { svc, mocks } = makeSvc();
    mocks.worldStateSnapshotService.buildSnapshotReadOnly.mockResolvedValue(makeSnapshot());
    mocks.resourceProjectionService.getUnifiedResourceState.mockResolvedValue([]);
    mocks.policyService.getActivePolicy.mockResolvedValue({ version: 1 } as never);
    mocks.outboxService.latestSequence.mockResolvedValue(0);
    mocks.constraintLoaderService.loadGlobalActive.mockResolvedValue([]);

    await svc.getContext(orgCtx);

    const passedCtx = mocks.worldStateSnapshotService.buildSnapshotReadOnly.mock.calls[0][0] as OrgContext;
    expect(passedCtx.primaryOrgId).toBe('org1');
    expect(passedCtx.userId).toBe('u1');
    const loaderCtx = mocks.constraintLoaderService.loadGlobalActive.mock.calls[0][0] as OrgContext;
    expect(loaderCtx.primaryOrgId).toBe('org1');
  });

  it('缺省 ctx（无 userContext）不抛错，org 归一化为空（向后兼容）', async () => {
    const { svc, mocks } = makeSvc();
    mocks.worldStateSnapshotService.buildSnapshotReadOnly.mockResolvedValue(makeSnapshot());
    mocks.resourceProjectionService.getUnifiedResourceState.mockResolvedValue([]);
    mocks.policyService.getActivePolicy.mockResolvedValue({ version: 1 } as never);
    mocks.outboxService.latestSequence.mockResolvedValue(0);
    mocks.constraintLoaderService.loadGlobalActive.mockResolvedValue([]);

    const ctx = await svc.getContext(undefined);

    expect(ctx.snapshotVersion).toBe('WS-20260810-0007');
    const passedCtx = mocks.worldStateSnapshotService.buildSnapshotReadOnly.mock.calls[0][0] as OrgContext;
    expect(passedCtx.primaryOrgId).toBe('');
  });

  it('dataQuality 汇总正确（stale/unknownLocation/degradedRoute/total）', async () => {
    const { svc, mocks } = makeSvc();
    mocks.worldStateSnapshotService.buildSnapshotReadOnly.mockResolvedValue(makeSnapshot());
    mocks.resourceProjectionService.getUnifiedResourceState.mockResolvedValue(makeResources());
    mocks.policyService.getActivePolicy.mockResolvedValue({ version: 7 } as never);
    mocks.outboxService.latestSequence.mockResolvedValue(42);
    mocks.constraintLoaderService.loadGlobalActive.mockResolvedValue([]);

    const ctx = await svc.getContext(orgCtx);

    expect(ctx.dataQuality).toEqual({
      staleResourceCount: 2, // p1(STALE) + s1(STALE)
      unknownLocationCount: 1, // p1：location.x/y/stationId 全 null；s1 有 stationId 不计
      degradedRouteCount: 2, // e2(blocked) + e3(congested)
      totalResources: 3,
    });
  });
});
