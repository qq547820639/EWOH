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
