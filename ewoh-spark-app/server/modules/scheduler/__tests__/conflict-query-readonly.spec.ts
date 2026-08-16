/* T04 / P1-5（G5）：GET /conflicts 纯读无副作用测试。
 *
 * 先跑红再改绿：现状 listConflicts → derive() → reconcile()（写 DB + SSE + audit）。
 * 本 spec 断言 GET /conflicts 后 DB 冲突行数与 SSE 事件数不变；reconcileNow 显式
 * 触发后行数与状态正确。
 */
/// <reference types="jest" />
import { ConflictService } from '../conflict.service';
import { ewohSchedulingConflict, ewohSchedulePlan } from '@server/database/schema';
import { WorldStateSnapshotService } from '../world-state.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { AuditService } from '@server/modules/shared/audit.service';
import { OutboxService } from '../outbox.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { testOrgContext } from './dispatch-test-harness';
import type { WorldStateSnapshot } from '@shared/api.interface';

/** 从 drizzle eq() SQL 的 queryChunks 提取谓词并应用于行（列名 → 行字段）。 */
const COL_TO_KEY: Record<string, string> = {
  conflict_id: 'conflictId',
  id: 'id',
  status: 'status',
  plan_id: 'planId',
};

function matchesEq(row: Record<string, unknown>, sqlExpr: unknown): boolean {
  const chunks = (sqlExpr as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] as { name?: string } | undefined;
    if (c && typeof c === 'object' && typeof c.name === 'string') {
      for (let j = i + 1; j < chunks.length; j++) {
        const n = chunks[j] as { encoder?: unknown; value?: unknown; name?: string } | undefined;
        if (n && typeof n === 'object' && 'encoder' in n && !Array.isArray(n.value)) {
          const key = COL_TO_KEY[c.name] ?? c.name;
          if (row[key] !== n.value) return false;
          break;
        }
        if (n && typeof n === 'object' && typeof n.name === 'string') break;
      }
    }
  }
  return true;
}

function makeService(seedConflicts: Array<Record<string, unknown>> = []) {
  const conflicts: Array<Record<string, unknown>> = seedConflicts.map((r) => ({ ...r }));
  const plans: Array<Record<string, unknown>> = [];
  const sseEvents: Array<string> = [];

  const conflictQuery = (filter?: (r: Record<string, unknown>) => boolean) => {
    const rows = () => (filter ? conflicts.filter(filter) : [...conflicts]);
    const q: any = Promise.resolve(rows());
    q.where = (pred: unknown) => conflictQuery((r) => matchesEq(r, pred));
    q.orderBy = () => conflictQuery(filter);
    q.limit = (n?: number) => Promise.resolve(rows().slice(0, n ?? rows().length));
    return q;
  };

  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        if (table === ewohSchedulingConflict) return conflictQuery();
        if (table === ewohSchedulePlan) {
          const q: any = Promise.resolve([...plans]);
          q.where = () => q;
          q.orderBy = () => q;
          return q;
        }
        return Promise.resolve([]);
      },
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const arr = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
        for (const row of arr) {
          if (table === ewohSchedulingConflict) {
            conflicts.push({ id: `id-${conflicts.length + 1}`, ...row });
          }
        }
        return { returning: () => Promise.resolve([]) };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (pred: unknown) => {
          if (table === ewohSchedulingConflict) {
            for (const row of conflicts) {
              if (matchesEq(row, pred)) Object.assign(row, patch);
            }
          }
          return { returning: () => Promise.resolve([]) };
        },
      }),
    }),
  };

  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
  };
  const worldState = {
    getCurrentWorldState: jest.fn().mockResolvedValue({
      snapshotVersion: 'CURRENT',
      ts: new Date().toISOString(),
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
      persons: [],
      tasks: [],
      devices: [],
      stations: [],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
    } satisfies WorldStateSnapshot),
  };
  const policy = {
    getConfig: jest.fn().mockResolvedValue({ triggerCooldownMs: 30_000 }),
  };
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const outbox = {
    enqueue: jest.fn().mockImplementation(async (eventType: string) => {
      sseEvents.push(eventType);
      return { id: 'evt', eventType, entityId: 'x', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() };
    }),
  };
  const svc = new ConflictService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    worldState as unknown as WorldStateSnapshotService,
    policy as unknown as SchedulingPolicyService,
    audit as unknown as AuditService,
    outbox as unknown as OutboxService,
  );
  return { svc, conflicts, sseEvents, outbox };
}

function conflictRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-1',
    conflictId: 'CFL-1',
    type: 'device_offline',
    severity: 'high',
    scope: 'resource',
    status: 'OPEN',
    taskIds: [],
    resourceId: 'd1',
    resourceType: 'device',
    planId: null,
    snapshotVersion: 'CURRENT',
    message: '设备 d1 当前离线',
    resolution: null,
    data: null,
    detectedAt: new Date('2026-08-01T00:00:00.000Z'),
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    suppressUntil: null,
    orgId: 'org1',
    ...overrides,
  };
}

describe('T04 / P1-5 GET /conflicts 纯读无副作用', () => {
  it('listConflicts 后 DB 冲突行数不变、无 SSE conflict.detected 发射', async () => {
    const { svc, conflicts, sseEvents } = makeService([conflictRow()]);
    const before = conflicts.length;
    const res = await svc.listConflicts({});
    expect(res.conflicts.length).toBeGreaterThanOrEqual(0);
    // 纯读：行数不变、无 SSE 写事件。
    expect(conflicts.length).toBe(before);
    expect(sseEvents).toEqual([]);
  });

  it('reconcileNow 显式触发后才落库新冲突 + 推 SSE（写路径与查询分离）', async () => {
    const { svc, conflicts, sseEvents } = makeService([]);
    // world-state 中有一台离线设备 → derive 产出 device_offline 冲突。
    (svc as unknown as { worldStateSnapshotService: { getCurrentWorldState: jest.Mock } })
      .worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
        snapshotVersion: 'CURRENT',
        ts: new Date().toISOString(),
        worldVersion: 1,
        entityVersions: {},
        reservations: [],
        safetyBlockedPersonIds: [],
        safetyBlockedDeviceIds: [],
        persons: [],
        tasks: [],
        devices: [
          { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: false, status: 'OFFLINE', dataQuality: 'FRESH' },
        ],
        stations: [],
        backlog: [],
        events: [],
        routeStatus: [],
        forbiddenZones: [],
        lockedAssignments: [],
      } satisfies WorldStateSnapshot);
    const before = conflicts.length;
    const result = await svc.reconcileNow(testOrgContext());
    expect(conflicts.length).toBeGreaterThan(before);
    expect(result.reconciledCount).toBeGreaterThan(0);
    expect(sseEvents).toContain('conflict.detected');
  });
});
