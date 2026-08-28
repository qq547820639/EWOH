/* T02 / P0-2（G2）：持久化人工约束跨 run 不丢 — constraint-run-loading 集成测试。
 *
 * 先跑红再改绿：当前 createRun / handleTrigger / conflict-preview 均传空 constraints，
 * 本 spec 断言三条求解路径必须加载 DB 中 active 的 LOCKED_PERSON / EXCLUDED_RESOURCE，
 * 且过期约束（expiresAtMs < now）不参与求解。
 */
/// <reference types="jest" />
import { ConstraintLoaderService } from '../constraint-loader.service';
import { SchedulerService } from '../scheduler.service';
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import { ConflictPreviewService } from '../conflict-preview.service';
import { SolverService } from '../solver.service';
import { PlanService } from '../plan.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { AuditService } from '@server/modules/shared/audit.service';
import { ewohSchedulingConstraint } from '@server/database/schema';
import { testOrgContext } from './dispatch-test-harness';
import type { SchedulingConstraint, WorldStateSnapshot } from '@shared/api.interface';

/** 最小约束行（standalone_023 真实列）。 */
function constraintRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cid-1',
    constraintId: 'CON-1',
    planId: null,
    taskId: 't1',
    type: 'LOCKED_PERSON',
    valueJson: { personId: 'p1', operator: 'leader1', reason: '人工锁定', snapshotVersion: 'WS-1' },
    active: true,
    validFromMs: null,
    expiresAtMs: null,
    orgId: 'org1',
    source: 'manual',
    deactivatedAt: null,
    deactivatedBy: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** 最小 select 链 fake db（仅约束表；where 为 no-op 但记录条件，供查询构造断言）。 */
function makeDb(constraints: Array<Record<string, unknown>>) {
  const captured: unknown[] = [];
  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        if (table === ewohSchedulingConstraint) {
          const q: any = Promise.resolve([...constraints]);
          q.where = (cond: unknown) => {
            captured.push(cond);
            return q;
          };
          q.orderBy = () => q;
          q.limit = () => Promise.resolve([...constraints].slice(0, 1));
          return q;
        }
        const q2: any = Promise.resolve([]);
        q2.where = () => q2;
        q2.orderBy = () => q2;
        q2.limit = () => Promise.resolve([]);
        return q2;
      },
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  };
  return { db, captured };
}

/** 将 drizzle 条件序列化为可断言文本（列名 → {column}，跳过表引用避免循环）。 */
function condText(cond: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(cond, (key, v) => {
    if (key === 'table' || key === 'config' || key === 'primaryKeys' || key === 'uniqueKeys' || key === 'foreignKeys' || key === 'indexes' || key === 'checks' || key === 'columns' || key === 'schema') {
      return undefined;
    }
    if (typeof v === 'bigint') return String(v);
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      const o = v as Record<string, unknown>;
      if ('name' in o && 'keyAsName' in o && 'columnType' in o) {
        return { column: o.name };
      }
      if ('value' in o && typeof o.value === 'object' && o.value !== null && '0' in (o.value as object)) {
        return (o.value as Record<string, unknown>)['0'];
      }
    }
    return v;
  });
}

function makeLoader(constraints: Array<Record<string, unknown>>) {
  const { db, captured } = makeDb(constraints);
  const loader = new ConstraintLoaderService(
    db,
    { runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()) } as never,
  );
  return { loader, db, captured };
}

function makeSnapshot(): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
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
  };
}

describe('T02 / P0-2 constraint-run-loading', () => {
  describe('ConstraintLoaderService', () => {
    it('loadGlobalActive 反序列化约束行（真实列 + valueJson 兼容：LOCKED_PERSON）', async () => {
      const { loader } = makeLoader([constraintRow()]);
      const ctx = testOrgContext();
      const result = await loader.loadGlobalActive(ctx, Date.now());
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('LOCKED_PERSON');
      expect(result[0].personId).toBe('p1');
      expect(result[0].operator).toBe('leader1');
      expect(result[0].expiresAtMs).toBeNull();
      expect(result[0].orgId).toBe('org1');
      expect(result[0].source).toBe('manual');
    });

    it('loadGlobalActive 构造 active + org_id + expires_at_ms 过滤查询（org/有效期语义交给 SQL）', async () => {
      const { loader, captured } = makeLoader([constraintRow()]);
      const ctx = testOrgContext();
      await loader.loadGlobalActive(ctx, 1_700_000_000_000);
      expect(captured).toHaveLength(1);
      const text = condText(captured[0]);
      // 过滤列必须出现在查询中（SQL 层执行过滤；本机无 postgres 时 CI 真实验证）。
      expect(text).toContain('"column":"active"');
      expect(text).toContain('"column":"org_id"');
      expect(text).toContain('"column":"expires_at_ms"');
      // 请求 org 值必须绑定到查询参数。
      expect(text).toContain('"org1"');
    });

    it('loadForPlan 合并继承约束与请求约束（重排 [] 不丢人工 LOCK）', async () => {
      const { loader } = makeLoader([
        constraintRow({ constraintId: 'CON-INHERIT', planId: 'PLAN-1', type: 'EXCLUDED_RESOURCE', valueJson: { deviceId: 'd9' } }),
      ]);
      const ctx = testOrgContext();
      const merged = await loader.loadForPlan('PLAN-1', [], ctx);
      expect(merged.some((c) => c.type === 'EXCLUDED_RESOURCE' && c.deviceId === 'd9')).toBe(true);
    });

    it('hashConstraints 对相同约束（键序不同）产出相同哈希；不同约束不同哈希', async () => {
      const { loader } = makeLoader([]);
      const a: SchedulingConstraint[] = [
        { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p1', expiresAtMs: 123 },
      ];
      const b: SchedulingConstraint[] = [
        { expiresAtMs: 123, personId: 'p1', taskId: 't1', type: 'LOCKED_PERSON' },
      ];
      const c: SchedulingConstraint[] = [
        { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p2', expiresAtMs: 123 },
      ];
      expect(loader.hashConstraints(a)).toBe(loader.hashConstraints(b));
      expect(loader.hashConstraints(a)).not.toBe(loader.hashConstraints(c));
    });
  });

  describe('createRun 加载 active constraints（P0-2 主链路）', () => {
    it('createRun 传给 solveVariants 的 constraints 包含 DB 中 active LOCKED_PERSON', async () => {
      const { db } = makeDb([constraintRow()]);
      const requestDatabaseContext = {
        runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
      };
      const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
      const triggerService = { evaluate: jest.fn().mockResolvedValue({ runId: 'RUN-1', triggerType: 'MANUAL', triggerEntityId: null }) };
      const solverService = { solve: jest.fn(), solveVariants: jest.fn().mockResolvedValue([]) };
      // b9f406c：预览路径改用 buildSnapshotReadOnly（只读快照），mock 同步补齐。
      const worldStateSnapshotService = {
        buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
        buildSnapshotReadOnly: jest.fn().mockResolvedValue(makeSnapshot()),
      };
      const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };
      const policyService = { getActivePolicy: jest.fn(), getPolicy: jest.fn(), getConfig: jest.fn(), getConfigByVersion: jest.fn() };
      const constraintLoader = new ConstraintLoaderService(
        db,
        requestDatabaseContext as never,
      );

      const svc = new SchedulerService(
        db,
        requestDatabaseContext as never,
        auditService as never,
        worldStateSnapshotService as unknown as WorldStateSnapshotService,
        triggerService as never,
        solverService as unknown as SolverService,
        planService as unknown as PlanService,
        { loadGraph: jest.fn(), calculateRoute: jest.fn() } as never,
        { check: jest.fn() } as never,
        { estimate: jest.fn() } as never,
        policyService as never,
        { deriveKpis: jest.fn() } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      // P0-2：SchedulerService 通过可选注入的 loader 加载全局 active 约束。
      (svc as unknown as { constraintLoaderService?: ConstraintLoaderService }).constraintLoaderService =
        constraintLoader;

      await svc.createRun({ trigger: 'MANUAL' }, testOrgContext());

      const args = (solverService.solveVariants as jest.Mock).mock.calls[0];
      expect(args).toBeDefined();
      const passed = args[1] as SchedulingConstraint[];
      expect(passed.some((c) => c.type === 'LOCKED_PERSON' && c.personId === 'p1')).toBe(true);
    });
  });

  describe('handleTrigger 加载 active constraints（事件驱动/局部重排）', () => {
    it('handleTrigger 传给 solveVariants 的 constraints 包含 EXCLUDED_RESOURCE', async () => {
      const { db } = makeDb([
        constraintRow({ constraintId: 'CON-EX', type: 'EXCLUDED_RESOURCE', valueJson: { deviceId: 'd9' } }),
      ]);
      const requestDatabaseContext = {
        runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
      };
      const triggerService = { evaluate: jest.fn().mockResolvedValue({ runId: 'RUN-2', triggerType: 'DEVICE_OFFLINE', triggerEntityId: 'd9' }) };
      const solverService = { solve: jest.fn(), solveVariants: jest.fn().mockResolvedValue([]) };
      // b9f406c：预览路径改用 buildSnapshotReadOnly（只读快照），mock 同步补齐。
      const worldStateSnapshotService = {
        buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
        buildSnapshotReadOnly: jest.fn().mockResolvedValue(makeSnapshot()),
      };
      const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };
      const policyService = { getActivePolicy: jest.fn(), getPolicy: jest.fn(), getConfig: jest.fn(), getConfigByVersion: jest.fn() };
      const constraintLoader = new ConstraintLoaderService(
        db,
        requestDatabaseContext as never,
      );

      const svc = new ReplanCoordinatorService(
        db,
        requestDatabaseContext as never,
        triggerService as never,
        worldStateSnapshotService as unknown as WorldStateSnapshotService,
        solverService as unknown as SolverService,
        planService as unknown as PlanService,
        policyService as never,
      );
      (svc as unknown as { constraintLoaderService?: ConstraintLoaderService }).constraintLoaderService =
        constraintLoader;

      await svc.handleTrigger('DEVICE_OFFLINE', 'd9', testOrgContext());

      const args = (solverService.solveVariants as jest.Mock).mock.calls[0];
      expect(args).toBeDefined();
      const passed = args[1] as SchedulingConstraint[];
      expect(passed.some((c) => c.type === 'EXCLUDED_RESOURCE' && c.deviceId === 'd9')).toBe(true);
    });
  });

  describe('conflict-preview 加载约束（P0-2 预览求解）', () => {
    it('preview 求解使用 loadForPlan 合并的约束（baselinePlanId 关联 LOCK 生效）', async () => {
      const { db } = makeDb([
        constraintRow({ constraintId: 'CON-PREVIEW', planId: 'PLAN-1', type: 'LOCKED_PERSON', valueJson: { personId: 'p1' } }),
      ]);
      const requestDatabaseContext = {
        runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
      };
      const solverService = { solve: jest.fn(), solveVariants: jest.fn().mockResolvedValue([]) };
      const planService = {
        getPlan: jest.fn().mockRejectedValue(new Error('not found')),
        persistPlan: jest.fn(),
      };
      const planCompareService = { compare: jest.fn().mockReturnValue(null) };
      // b9f406c：预览路径改用 buildSnapshotReadOnly（只读快照），mock 同步补齐。
      const worldStateSnapshotService = {
        buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
        buildSnapshotReadOnly: jest.fn().mockResolvedValue(makeSnapshot()),
      };
      const replanCoordinator = {
        impactAnalysis: jest.fn().mockResolvedValue({ affectedTaskIds: ['t1'], frozenTaskIds: [], reason: 'test' }),
      };
      const constraintLoader = new ConstraintLoaderService(
        db,
        requestDatabaseContext as never,
      );

      const svc = new ConflictPreviewService(
        planService as unknown as PlanService,
        solverService as unknown as SolverService,
        planCompareService as never,
        worldStateSnapshotService as unknown as WorldStateSnapshotService,
        replanCoordinator as never,
      );
      (svc as unknown as { constraintLoaderService?: ConstraintLoaderService }).constraintLoaderService =
        constraintLoader;

      await svc.preview(
        'CFL-1',
        { type: 'person_unavailable', scope: 'resource', resourceId: 'p1', taskIds: ['t1'] },
        'PLAN-1',
      );

      const args = (solverService.solveVariants as jest.Mock).mock.calls[0];
      expect(args).toBeDefined();
      const passed = args[1] as SchedulingConstraint[];
      expect(passed.some((c) => c.type === 'LOCKED_PERSON' && c.personId === 'p1')).toBe(true);
    });
  });
});
