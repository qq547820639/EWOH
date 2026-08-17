/* Phase 3 / P3-T1：Conflict Lifecycle 持久化 + API 服务层单测。
 *
 * 覆盖（02 §6.1 状态机 + 决策 D-C）：
 * - 推导复现 → INSERT OPEN + conflict.detected SSE + audit；
 * - OPEN → ACKNOWLEDGED → RESOLVED（人工）；
 * - OPEN → SUPPRESSED →（suppressUntil 到期）→ OPEN（自动回）；
 * - 推导消失 → 自动 RESOLVED（resolution=auto_cleared）+ audit + SSE conflict.resolved；
 * - suppressUntil 内不重复推 SSE（reconcile 保持 SUPPRESSED）；
 * - 列表/详情旧字段向后兼容（status 缺省 OPEN）。
 */
/// <reference types="jest" />
import { ConflictService } from '../conflict.service';
import { ewohSchedulingConflict, ewohSchedulePlan } from '@server/database/schema';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { testOrgContext } from './dispatch-test-harness';

const HOUR = 3600_000;

/** 从 drizzle eq() SQL 的 queryChunks 提取谓词并应用于行（列名 → 行字段）。 */
const COL_TO_KEY: Record<string, string> = {
  conflict_id: 'conflictId',
  id: 'id',
  status: 'status',
  plan_id: 'planId',
  type: 'type',
  active: 'active',
  config_version: 'configVersion',
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

function makeDb(seedConflicts: Array<Record<string, unknown>> = [], seedPlans: Array<Record<string, unknown>> = []) {
  const conflicts: Array<Record<string, unknown>> = seedConflicts.map((r) => ({ ...r }));
  const plans: Array<Record<string, unknown>> = seedPlans.map((r) => ({ ...r }));

  const conflictQuery = (filter?: (r: Record<string, unknown>) => boolean, sortAsc = false) => {
    const rows = () => {
      let r = [...conflicts];
      if (filter) r = r.filter(filter);
      if (sortAsc)
        r = r.sort((a, b) =>
          String(a.detectedAt ?? '').localeCompare(String(b.detectedAt ?? '')),
        );
      return r;
    };
    const q: any = Promise.resolve(rows());
    q.where = (pred: unknown) => conflictQuery((r) => matchesEq(r, pred), sortAsc);
    q.orderBy = () => conflictQuery(filter, true);
    q.limit = (n?: number) => Promise.resolve(rows().slice(0, n ?? rows().length));
    return q;
  };

  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        if (table === ewohSchedulingConflict) return conflictQuery(undefined, false);
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
            // R2-SSV-11：返回真实命中行（UPDATE ... RETURNING 行数语义）。
            const hit: Array<Record<string, unknown>> = [];
            for (const row of conflicts) {
              if (matchesEq(row, pred)) {
                Object.assign(row, patch);
                hit.push(row);
              }
            }
            return { returning: () => Promise.resolve(hit) };
          }
          return { returning: () => Promise.resolve([]) };
        },
      }),
    }),
  };
  return { db, conflicts, plans };
}

/** 世界状态 mock：离线设备 d1（可推导 device_offline 冲突）。 */
const OFFLINE_STATE = {
  worldVersion: 1,
  entityVersions: {},
  reservations: [],
  persons: [],
  tasks: [],
  devices: [
    { id: 'd1', batteryPct: 100, online: false, status: 'OFFLINE', dataQuality: 'FRESH' },
  ],
  stations: [],
  backlog: [],
  events: [],
  routeStatus: [],
  forbiddenZones: [],
  lockedAssignments: [],
} as unknown as WorldStateSnapshot;

function makeSvc(seedConflicts: Array<Record<string, unknown>> = [], state: Record<string, unknown> = {}) {
  const { db, conflicts, plans } = makeDb(seedConflicts);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const worldState = {
    getCurrentWorldState: jest.fn().mockResolvedValue({ ...OFFLINE_STATE, ...state }),
    isPlanStale: jest.fn().mockResolvedValue(false),
  };
  const policy = {
    getConfig: jest.fn().mockResolvedValue({ minBatteryPct: 40, triggerCooldownMs: 30_000 }),
  };
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const outbox = { enqueue: jest.fn().mockResolvedValue({ sequence: 1 }) };
  const svc = new ConflictService(
    db,
    requestDatabaseContext as never,
    worldState as never,
    policy as never,
    audit as never,
    outbox as never,
  );
  return { svc, db, conflicts, plans, mocks: { worldState, audit, outbox } };
}

describe('P3-T1: ConflictService 推导 + 归并落库', () => {
  it('新推导冲突 → 落库 OPEN + conflict.detected SSE + audit（T04：写路径走 reconcileNow）', async () => {
    const { svc, conflicts, mocks } = makeSvc();
    const res = await svc.reconcileNow(testOrgContext());
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].type).toBe('device_offline');
    expect(res.conflicts[0].status).toBe('OPEN');
    // 落库行存在且为 OPEN。
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe('OPEN');
    expect(conflicts[0].conflictId).toBe(res.conflicts[0].conflictId);
    // SSE + audit。
    expect(mocks.outbox.enqueue).toHaveBeenCalledWith(
      'conflict.detected',
      res.conflicts[0].conflictId,
      expect.objectContaining({ type: 'device_offline' }),
      // NEST-107：SSE 事件携带推导上下文 orgId（testOrgContext → org1）。
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'conflict' }),
    );
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.detected' }),
    );
  });

  it('推导消失 → 自动 RESOLVED（resolution=auto_cleared）+ audit + SSE conflict.resolved（决策 D-C）', async () => {
    // 先推导一次（产生落库 OPEN 行），再让设备恢复在线（推导消失）。
    const first = makeSvc();
    await first.svc.reconcileNow(testOrgContext());
    const conflictId = first.conflicts[0].conflictId;
    // 第二次：设备恢复（无 device_offline 推导）。
    const { svc, conflicts, mocks } = makeSvc(first.conflicts, {
      devices: [
        { id: 'd1', batteryPct: 100, online: true, status: 'AVAILABLE', dataQuality: 'FRESH' },
      ],
    });
    const res = await svc.reconcileNow(testOrgContext());
    expect(res.conflicts).toHaveLength(0);
    // 落库行已自动 RESOLVED。
    const row = conflicts.find((c) => c.conflictId === conflictId)!;
    expect(row.status).toBe('RESOLVED');
    expect(row.resolution).toBe('auto_cleared');
    expect(row.resolvedBy).toBe('system');
    expect(mocks.outbox.enqueue).toHaveBeenCalledWith(
      'conflict.resolved',
      conflictId,
      expect.objectContaining({ status: 'RESOLVED', resolution: 'auto_cleared' }),
      // NEST-107（2026-08-17）：SSE 事件携带推导上下文 orgId（此前恒 null 被
      // 全局放行）；reconcileNow(testOrgContext()) 的 org 即 org1。
      'org1',
      undefined,
      expect.anything(),
    );
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.resolve', reason: 'auto_cleared' }),
    );
  });

  it('列表/详情旧字段向后兼容（status 缺省 OPEN、snapshotVersion=CURRENT）', async () => {
    const { svc } = makeSvc();
    // T04：查询纯读（listConflicts 不写）；详情读取已落库行（先 reconcileNow 落库）。
    await svc.reconcileNow(testOrgContext());
    const res = await svc.listConflicts({ type: 'device_offline' });
    expect(res.conflicts[0].snapshotVersion).toBe('CURRENT');
    expect(res.conflicts[0].severity).toBe('high');
    const detail = await svc.getConflictDetail(res.conflicts[0].conflictId);
    expect(detail.conflictId).toBe(res.conflicts[0].conflictId);
    expect(detail.type).toBe('device_offline');
  });
});

describe('P3-T1: Conflict 生命周期状态机（02 §6.1）', () => {
  it('OPEN → ACKNOWLEDGED → RESOLVED（人工 acknowledge + resolve + 审计）', async () => {
    const { svc, conflicts, mocks } = makeSvc();
    await svc.reconcileNow(testOrgContext());
    const conflictId = String(conflicts[0].conflictId);

    const acked = await svc.acknowledge(conflictId, 'op1', '已知问题');
    expect(acked.status).toBe('ACKNOWLEDGED');
    expect(acked.acknowledgedBy).toBe('op1');
    expect(acked.acknowledgedAt).toBeTruthy();
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.acknowledge', entityId: conflictId }),
    );
    expect(mocks.outbox.enqueue).toHaveBeenCalledWith(
      'conflict.acknowledged',
      conflictId,
      expect.objectContaining({ status: 'ACKNOWLEDGED' }),
      // NEST-107：SSE 事件携带 orgId（人工转移路径 ctx 未传 → null 保持全局语义）。
      null,
      undefined,
      expect.anything(),
    );

    const resolved = await svc.resolve(conflictId, 'op2', '已处理', 'manual_fix');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedBy).toBe('op2');
    expect(resolved.resolution).toBe('manual_fix');
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.resolve', entityId: conflictId }),
    );
    // 落库行同步。
    expect(conflicts[0].status).toBe('RESOLVED');
  });

  it('OPEN → SUPPRESSED →（suppressUntil 到期）→ OPEN 自动回', async () => {
    const { svc, conflicts, mocks } = makeSvc();
    await svc.reconcileNow(testOrgContext());
    const conflictId = String(conflicts[0].conflictId);

    const suppressed = await svc.suppress(conflictId, 'op1', '暂时忽略', Date.now() + HOUR);
    expect(suppressed.status).toBe('SUPPRESSED');
    expect(suppressed.suppressUntil).toBeTruthy();
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.suppress' }),
    );

    // suppressUntil 内：reconcile 保持 SUPPRESSED，不重复推 conflict.detected。
    const before = mocks.outbox.enqueue.mock.calls.length;
    const res1 = await svc.reconcileNow(testOrgContext());
    expect(res1.conflicts[0].status).toBe('SUPPRESSED');
    expect(mocks.outbox.enqueue.mock.calls.length).toBe(before); // 无新增 SSE

    // suppressUntil 到期：reconcile 自动回 OPEN + audit conflict.reopen。
    await new Promise((r) => setTimeout(r, 5)); // 确保时间推进
    const expiredRow = conflicts[0];
    (expiredRow as { suppressUntil: Date }).suppressUntil = new Date(Date.now() - 1000);
    const res2 = await svc.reconcileNow(testOrgContext());
    expect(res2.conflicts[0].status).toBe('OPEN');
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.reopen', reason: 'suppress_until expired' }),
    );
  });

  it('ACKNOWLEDGED → SUPPRESSED 允许；RESOLVED 不可再 suppress', async () => {
    const { svc, conflicts } = makeSvc();
    await svc.reconcileNow(testOrgContext());
    const conflictId = String(conflicts[0].conflictId);
    await svc.acknowledge(conflictId, 'op1', 'ack');
    const suppressed = await svc.suppress(conflictId, 'op1', 'suppress', Date.now() + HOUR);
    expect(suppressed.status).toBe('SUPPRESSED');

    // RESOLVED 后再 suppress → 拒绝。
    const { svc: svc2, conflicts: conflicts2 } = makeSvc();
    await svc2.reconcileNow(testOrgContext());
    const id2 = String(conflicts2[0].conflictId);
    await svc2.resolve(id2, 'op2', 'done');
    await expect(svc2.suppress(id2, 'op2', 'suppress')).rejects.toThrow(
      'cannot be suppressed from status RESOLVED',
    );
  });

  it('RESOLVED 复现 → reopen OPEN + audit conflict.reopen（reappeared）', async () => {
    const first = makeSvc();
    await first.svc.reconcileNow(testOrgContext());
    const conflictId = String(first.conflicts[0].conflictId);
    await first.svc.resolve(conflictId, 'op1', 'done');
    // 设备再次离线（复现）。
    const { svc, conflicts, mocks } = makeSvc(first.conflicts);
    const res = await svc.reconcileNow(testOrgContext());
    expect(res.conflicts[0].status).toBe('OPEN');
    expect(mocks.audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict.reopen', reason: 'conflict reappeared after RESOLVED' }),
    );
  });

  it('不存在的冲突 acknowledge/resolve/suppress → NotFoundException', async () => {
    const { svc } = makeSvc();
    await expect(svc.acknowledge('CFL-none', 'op')).rejects.toThrow('not found');
    await expect(svc.resolve('CFL-none', 'op')).rejects.toThrow('not found');
    await expect(svc.suppress('CFL-none', 'op')).rejects.toThrow('not found');
  });
});
