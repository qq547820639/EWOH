/* v0.7 A1：WorldStateSnapshotService 任务派生字段测试
 * 覆盖 productionImpact / safetyCritical / candidateStations 从已有字段派生的逻辑，
 * 验证「智能调度增强」不破坏既有快照语义，且缺省行为向后兼容。
 *
 * 复用 fake-db 模式：构造最小 drizzle select 链，返回预置行数据。
 */
/// <reference types="jest" />
import { WorldStateSnapshotService } from '../world-state.service';
import {
  ewohPersonnel,
  ewohDevice,
  ewohProductionTask,
  ewohSpatialEntity,
  ewohEvent,
  ewohRouteNode,
  ewohRouteEdge,
  ewohWorldStateSnapshot,
  ewohResourceReservation,
  ewohDeviceBinding,
} from '@server/database/schema';

/** 按表名返回行数据的 fake db。 */
function makeDb(rowsByTable: Partial<Record<string, unknown[]>>) {
  const from = jest.fn((table: unknown) => {
    const name = (table as { [Symbol.toStringTag]?: string })?.constructor?.name ?? '';
    const key =
      table === ewohPersonnel
        ? 'personnel'
        : table === ewohDevice
          ? 'device'
          : table === ewohProductionTask
            ? 'task'
            : table === ewohSpatialEntity
              ? 'spatial'
              : table === ewohEvent
                ? 'event'
                : table === ewohRouteNode
                  ? 'routeNode'
                  : table === ewohRouteEdge
                    ? 'routeEdge'
                    : table === ewohWorldStateSnapshot
                      ? 'snapshot'
                      : table === ewohResourceReservation
                        ? 'reservation'
                        : table === ewohDeviceBinding
                          ? 'binding'
                          : '';
    const rows = rowsByTable[key] ?? [];
    // reservation / binding 带 where 过滤；其余直接返回。
    if (key === 'reservation' || key === 'binding') {
      return { where: () => Promise.resolve(rows) };
    }
    return Promise.resolve(rows);
  });
  return { select: jest.fn(() => ({ from })) } as never;
}

function makeSvc(rowsByTable: Partial<Record<string, unknown[]>>) {
  const db = makeDb(rowsByTable);
  return new WorldStateSnapshotService(db, { runInTransaction: jest.fn() } as never);
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: '搬运任务A',
    taskType: 'material_handling',
    priority: 'urgent',
    status: 'pending',
    assigneeId: null,
    deviceId: null,
    spatialEntityId: 'S-1',
    planStart: null,
    planEnd: null,
    progress: 0,
    predecessorIds: null,
    requiredSkills: null,
    requiredCertifications: null,
    ...overrides,
  };
}

function spatialRow(entityId: string, overrides: Record<string, unknown> = {}) {
  return {
    entityId,
    entityType: 'station',
    name: entityId,
    parentId: 'Z-1',
    x: 0,
    y: 0,
    extra: null,
    ...overrides,
  };
}

describe('v0.7 A1: 任务派生字段（productionImpact / safetyCritical / candidateStations）', () => {
  it('urgent 任务 → productionImpact=1.0；high=0.7；medium=0.4；low=0.1', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [
        taskRow({ id: 't1', priority: 'urgent' }),
        taskRow({ id: 't2', priority: 'high' }),
        taskRow({ id: 't3', priority: 'medium' }),
        taskRow({ id: 't4', priority: 'low' }),
      ],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });

    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    expect(byId.get('t1')?.productionImpact).toBe(1.0);
    expect(byId.get('t2')?.productionImpact).toBe(0.7);
    expect(byId.get('t3')?.productionImpact).toBe(0.4);
    expect(byId.get('t4')?.productionImpact).toBe(0.1);
  });

  it('默认/未知优先级 → productionImpact=0（向后兼容）', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [taskRow({ id: 't1', priority: 'unknown_prio' })],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.tasks[0].productionImpact).toBe(0);
  });

  it('重体力/搬运任务类型 → safetyCritical=true；普通任务 → false', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [
        taskRow({ id: 't1', taskType: 'material_handling' }),
        taskRow({ id: 't2', taskType: 'inspection' }),
      ],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    expect(byId.get('t1')?.safetyCritical).toBe(true);
    expect(byId.get('t2')?.safetyCritical).toBe(false);
  });

  it('任务绑定工位本身 → candidateStations 回退 [stationId]', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [taskRow({ id: 't1', spatialEntityId: 'S-1' })],
      spatial: [spatialRow('S-1', { entityType: 'station' })],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.tasks[0].candidateStations).toEqual(['S-1']);
  });

  it('任务绑定区域（非 station）→ candidateStations = 区域内全部工位', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [taskRow({ id: 't1', spatialEntityId: 'Z-1' })],
      spatial: [
        spatialRow('Z-1', { entityType: 'zone', parentId: null }),
        spatialRow('S-1', { entityType: 'station', parentId: 'Z-1' }),
        spatialRow('S-2', { entityType: 'station', parentId: 'Z-1' }),
        spatialRow('S-3', { entityType: 'device', parentId: 'Z-1' }), // 非 station 不应入选
      ],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.tasks[0].candidateStations).toEqual(['S-1', 'S-2']);
  });

  it('无空间实体绑定 → candidateStations=[]（求解器回退无候选约束）', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [taskRow({ id: 't1', spatialEntityId: null })],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.tasks[0].candidateStations).toEqual([]);
  });
});

describe('v0.7 Batch5.3: 设备能力与任务能力需求派生', () => {
  it('EXO-Pro 型号设备 → capabilities 含 exo-lift；普通任务无能力需求', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [
        { id: 'd1', deviceId: 'EXO-001', deviceModel: 'EXO-Pro X1', online: true, batteryPct: 80 },
      ],
      task: [taskRow({ id: 't1', taskType: 'inspection' })],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ devices: Array<Record<string, unknown>>; tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.devices[0].capabilities).toContain('exo-lift');
    expect(state.tasks[0].requiredDeviceCapabilities).toEqual([]);
  });

  it('搬运任务 → requiredDeviceCapabilities 含 exo-lift（能力匹配生效）', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [taskRow({ id: 't1', taskType: 'material_handling' })],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.tasks[0].requiredDeviceCapabilities).toEqual(['exo-lift']);
  });

  it('未知型号设备 → capabilities 空数组（不误判）', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [
        { id: 'd1', deviceId: 'UNKNOWN-1', deviceModel: 'custom-rig', online: true, batteryPct: 80 },
      ],
      task: [],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ devices: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.devices[0].capabilities).toEqual([]);
  });
});

describe('P1-T2: 领域新列优先装配（新列真实值 > 派生兜底 + derived 标记）', () => {
  it('safety_critical 列有值 → 取真实值且不标记 derived；列无值 → 派生并标记', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [
        taskRow({ id: 't1', taskType: 'inspection', safetyCritical: true }),
        taskRow({ id: 't2', taskType: 'material_handling', safetyCritical: false }),
        taskRow({ id: 't3', taskType: 'material_handling' }), // 列无值 → 派生
      ],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    // 列有值 → 真实值优先，不标记 derived.safetyCritical
    expect(byId.get('t1')?.safetyCritical).toBe(true);
    expect((byId.get('t1')?.derived as string[]).includes('safetyCritical')).toBe(false);
    expect(byId.get('t2')?.safetyCritical).toBe(false);
    expect((byId.get('t2')?.derived as string[]).includes('safetyCritical')).toBe(false);
    // 列无值 → 白名单派生兜底并标记 derived
    expect(byId.get('t3')?.safetyCritical).toBe(true);
    expect((byId.get('t3')?.derived as string[]).includes('safetyCritical')).toBe(true);
  });

  it('preemptible / skillMatchMode / productionImpact 新列优先，无值派生并标记', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [
        taskRow({ id: 't1', priority: 'urgent', preemptible: true, skillMatchMode: 'ANY', productionImpact: 0.6 }),
        taskRow({ id: 't2', priority: 'urgent' }), // 全部无值 → 派生
      ],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    // t1：真实列
    expect(byId.get('t1')?.preemptible).toBe(true);
    expect(byId.get('t1')?.skillMatchMode).toBe('ANY');
    expect(byId.get('t1')?.productionImpact).toBe(0.6);
    // t2：派生兜底（urgent → productionImpact=1.0），且带标记
    expect(byId.get('t2')?.preemptible).toBe(false);
    expect(byId.get('t2')?.skillMatchMode).toBe('ALL');
    expect(byId.get('t2')?.productionImpact).toBe(1.0);
    const derived2 = byId.get('t2')?.derived as string[];
    expect(derived2).toContain('preemptible');
    expect(derived2).toContain('skillMatchMode');
    expect(derived2).toContain('productionImpact');
  });

  it('领域新列透传：时间窗/下游影响/工位能力/偏好与排除资源/basePriority', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [
        taskRow({
          id: 't1',
          basePriority: 'P0',
          earliestStartMs: 1000,
          latestFinishMs: 9000,
          downstreamImpact: 0.8,
          requiredStationCapabilities: ['exo-lift'],
          preferredResources: ['p1'],
          excludedResources: ['p2'],
        }),
        taskRow({ id: 't2' }), // 全部无值 → null/空数组
      ],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ tasks: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    expect(byId.get('t1')?.basePriority).toBe('P0');
    expect(byId.get('t1')?.earliestStartMs).toBe(1000);
    expect(byId.get('t1')?.latestFinishMs).toBe(9000);
    expect(byId.get('t1')?.downstreamImpact).toBe(0.8);
    expect(byId.get('t1')?.requiredStationCapabilities).toEqual(['exo-lift']);
    expect(byId.get('t1')?.preferredResources).toEqual(['p1']);
    expect(byId.get('t1')?.excludedResources).toEqual(['p2']);
    // 无值 → 显式 null/空数组（绝不伪造正常值）
    expect(byId.get('t2')?.basePriority).toBeNull();
    expect(byId.get('t2')?.earliestStartMs).toBeNull();
    expect(byId.get('t2')?.latestFinishMs).toBeNull();
    expect(byId.get('t2')?.downstreamImpact).toBeNull();
    expect(byId.get('t2')?.requiredStationCapabilities).toEqual([]);
    expect(byId.get('t2')?.preferredResources).toEqual([]);
    expect(byId.get('t2')?.excludedResources).toEqual([]);
  });

  it('device capabilities 列优先：列有值取真实值；列无值才按型号派生并标记 derived', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [
        { id: 'd1', deviceId: 'D-001', deviceModel: 'EXO-Pro X1', capabilities: ['crane'], online: true, batteryPct: 80 },
        { id: 'd2', deviceId: 'D-002', deviceModel: 'EXO-Pro X1', online: true, batteryPct: 80 },
      ],
      task: [],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ devices: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.devices.map((d) => [d.id, d]));
    // 列有值 → 真实值优先
    expect(byId.get('d1')?.capabilities).toEqual(['crane']);
    expect((byId.get('d1')?.derived as string[]).includes('capabilities')).toBe(false);
    // 列无值 → 型号派生兜底 + derived 标记
    expect(byId.get('d2')?.capabilities).toEqual(['exo-lift']);
    expect((byId.get('d2')?.derived as string[]).includes('capabilities')).toBe(true);
  });

  it('device 位置读 location_lat/lng，不再借用人员坐标；无位置 → UNKNOWN(null) 而非 0', async () => {
    const svc = makeSvc({
      personnel: [
        { id: 'p1', name: 'p1', status: 'available', spatialEntityId: 'SE-P1', updatedAt: new Date() },
      ],
      device: [
        // 有自身位置：与绑定人员位置不同，应取设备自身坐标。
        { id: 'd1', deviceId: 'D-001', online: true, batteryPct: 80, locationLat: 500, locationLng: 600, locationConfidence: 0.9, lastTelemetryAt: new Date() },
        // 无位置：x/y 应为 null（UNKNOWN），绝不借人员坐标或填 0。
        { id: 'd2', deviceId: 'D-002', online: true, batteryPct: 80, lastTelemetryAt: new Date() },
      ],
      spatial: [
        { entityId: 'SE-P1', entityType: 'person', name: 'SE-P1', parentId: 'Z-1', x: 111, y: 222, extra: null },
      ],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [
        { deviceId: 'D-001', targetType: 'person', targetId: 'p1', status: 'active' },
        { deviceId: 'D-002', targetType: 'person', targetId: 'p1', status: 'active' },
      ],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ devices: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.devices.map((d) => [d.id, d]));
    // 有位置 → 取设备自身 location_lat/lng（人员位置是 111/222，不应被借用）
    expect(byId.get('d1')?.x).toBe(500);
    expect(byId.get('d1')?.y).toBe(600);
    expect(byId.get('d1')?.locationConfidence).toBe(0.9);
    // 无位置 → UNKNOWN(null)，非 0
    expect(byId.get('d2')?.x).toBeNull();
    expect(byId.get('d2')?.y).toBeNull();
    expect(byId.get('d2')?.locationConfidence).toBeNull();
  });

  it('station capacity 读列（不再取 extra），queue/availableWindows 读列', async () => {
    const svc = makeSvc({
      personnel: [],
      device: [],
      task: [],
      spatial: [
        spatialRow('S-1', { entityType: 'station', capacity: 3, queue: ['t1', 't2'], availableWindows: [{ startMs: 100, endMs: 200 }] }),
        spatialRow('S-2', { entityType: 'station', extra: { capacity: 9 } }), // 旧 extra 不再读取
      ],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ stations: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.stations.map((s) => [s.id, s]));
    expect(byId.get('S-1')?.capacity).toBe(3);
    expect(byId.get('S-1')?.queue).toEqual(['t1', 't2']);
    expect(byId.get('S-1')?.availableWindows).toEqual([{ startMs: 100, endMs: 200 }]);
    // extra.capacity 不再作为容量来源
    expect(byId.get('S-2')?.capacity).toBeNull();
  });

  it('person 坐标缺失 → UNKNOWN(null) 而非 0', async () => {
    const svc = makeSvc({
      personnel: [
        { id: 'p1', name: 'p1', status: 'available', spatialEntityId: null, updatedAt: new Date() },
        { id: 'p2', name: 'p2', status: 'available', spatialEntityId: 'SE-P2', updatedAt: new Date() },
      ],
      device: [],
      task: [],
      spatial: [
        { entityId: 'SE-P2', entityType: 'person', name: 'SE-P2', parentId: 'Z-1', x: null, y: null, extra: null },
      ],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ persons: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    const byId = new Map(state.persons.map((p) => [p.id, p]));
    // 无空间实体 → null
    expect(byId.get('p1')?.x).toBeNull();
    expect(byId.get('p1')?.y).toBeNull();
    // 空间实体 x/y 本身缺失 → null（而非 0）
    expect(byId.get('p2')?.x).toBeNull();
    expect(byId.get('p2')?.y).toBeNull();
  });

  it('person 新列透传：shift / workload / currentTaskId / certificationExpiry', async () => {
    const svc = makeSvc({
      personnel: [
        {
          id: 'p1', name: 'p1', status: 'available', spatialEntityId: null, updatedAt: new Date(),
          shift: 'A班', workload: 0.4, currentTaskId: 't1',
          certificationExpiry: [{ name: 'cert-a', expiresAtMs: 1234 }],
        },
      ],
      device: [],
      task: [],
      spatial: [],
      event: [],
      routeNode: [],
      routeEdge: [],
      reservation: [],
      binding: [],
    });
    const state = await (svc as unknown as { getCurrentWorldState(): Promise<{ persons: Array<Record<string, unknown>> }> })
      .getCurrentWorldState();
    expect(state.persons[0].shift).toBe('A班');
    expect(state.persons[0].workload).toBe(0.4);
    expect(state.persons[0].currentTaskId).toBe('t1');
    expect(state.persons[0].certificationExpiry).toEqual([{ name: 'cert-a', expiresAtMs: 1234 }]);
  });
});
