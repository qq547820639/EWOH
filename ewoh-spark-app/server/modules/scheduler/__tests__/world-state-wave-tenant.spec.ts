/// <reference types="jest" />
import { ConflictException } from '@nestjs/common';
import { WorldStateSnapshotService } from '../world-state.service';
import {
  ewohDeviceBinding,
  ewohEvent,
  ewohProductionTask,
  ewohResourceReservation,
  ewohRouteEdge,
  ewohRouteNode,
  ewohSchedulingPlanAssignment,
  ewohSpatialEntity,
  ewohWorldStateSnapshot,
} from '@server/database/schema';
import type { WorldStateSnapshot } from '@shared/api.interface';

const COL_TO_KEY: Record<string, string> = {
  assignment_id: 'assignmentId',
  created_at: 'createdAt',
  device_binding_id: 'deviceBindingId',
  event_id: 'eventId',
  node_id: 'nodeId',
  org_id: 'orgId',
  plan_id: 'planId',
  reservation_id: 'reservationId',
  route_edge_id: 'routeEdgeId',
  spatial_entity_id: 'spatialEntityId',
  status: 'status',
  target_type: 'targetType',
  task_id: 'taskId',
  snapshot_version: 'snapshotVersion',
};

function matches(row: Record<string, unknown>, expr: unknown): boolean {
  const chunks = (expr as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  const groups: Array<Array<() => boolean>> = [[]];
  let pending: string | null = null;
  for (const raw of chunks) {
    const c = raw as { name?: string; value?: unknown; encoder?: unknown; queryChunks?: unknown[] };
    if (!c || typeof c !== 'object') continue;
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pending = COL_TO_KEY[c.name] ?? c.name;
      continue;
    }
    if (!('encoder' in c)) {
      const text = Array.isArray(c.value) && c.value.every((v) => typeof v === 'string')
        ? c.value.join('')
        : typeof c.value === 'string' ? c.value : null;
      if (text != null) {
        if (/\bor\b/.test(text)) groups.push([]);
        else if (/is\s+null/i.test(text) && pending) {
          const key = pending;
          groups.at(-1)!.push(() => row[key] == null);
          pending = null;
        }
        continue;
      }
    }
    if ('encoder' in c && pending) {
      const key = pending;
      const expected = c.value;
      groups.at(-1)!.push(() => row[key] === expected);
      pending = null;
      continue;
    }
    if (Array.isArray(c.queryChunks)) {
      groups.at(-1)!.push(() => matches(row, raw));
    }
  }
  return groups.some((group) => group.length > 0 && group.every((check) => check()));
}

function makeDb() {
  const tables = new Map<unknown, Array<Record<string, unknown>>>([
    [ewohSchedulingPlanAssignment, [
      { planId: 'PLAN-SAME', status: 'dispatched', taskId: 'T1', orgId: 'org1' },
      { planId: 'PLAN-SAME', status: 'dispatched', taskId: 'T2', orgId: 'org2' },
    ]],
    [ewohResourceReservation, []],
    [ewohProductionTask, [
      { id: 'T1', orgId: 'org1' },
      { id: 'T2', orgId: 'org1' },
    ]],
    [ewohSpatialEntity, []],
    [ewohEvent, []],
    [ewohRouteNode, []],
    [ewohRouteEdge, []],
    [ewohDeviceBinding, []],
    [ewohWorldStateSnapshot, [{
      snapshotVersion: 'WS-WAVE-TENANT',
      orgId: 'org1',
      snapshotJson: {
        entityVersions: { 'task:T1': 1 },
        reservations: [],
      } satisfies Partial<WorldStateSnapshot>,
    }]],
  ]);

  const query = (table: unknown) => {
    let filter: ((row: Record<string, unknown>) => boolean) | undefined;
    const q: any = {
      then(resolve: (rows: unknown) => void) { resolve((tables.get(table) ?? []).filter((r) => !filter || filter(r))); },
      where(pred: unknown) {
        filter = (row) => matches(row, pred);
        return q;
      },
      orderBy: () => q,
      limit: () => q,
    };
    return q;
  };

  const db: any = { select: () => ({ from: query }) };
  return db;
}

describe('assertFreshForWave tenant scoping', () => {
  it('does not strip another tenant assignment that shares the same planId', async () => {
    const db = makeDb();
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
    };
    const resourceProjectionService = {
      projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
    };
    const svc = new WorldStateSnapshotService(
      db,
      requestDatabaseContext as never,
      resourceProjectionService as never,
    );

    await expect(
      svc.assertFreshForWave(
        'WS-WAVE-TENANT',
        'PLAN-SAME',
        { userId: 'u1', primaryOrgId: 'org1' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
