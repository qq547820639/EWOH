/* R2-SSV 二轮审计修复回归测试（调度服务面）。
 *
 * 覆盖：
 *   - R2-SSV-01：scheduling-policy 版本读写面 org 条件 + 激活不改写行 orgId；
 *   - R2-SSV-02：kpi aggregateForPolicyEvaluation orgId 透传（HTTP/系统上下文）；
 *   - R2-SSV-03：shadow plan 落库与 isShadow 标记同事务（补偿路径不留裸方案）；
 *   - R2-SSV-04：resource-projection 维护/质量事实 org 过滤；
 *   - R2-SSV-05：applyExecutionAdvancement CAS 0 命中不发事件；
 *   - R2-SSV-13：recordActuals 状态推进受派者/可信角色授权。
 */
/// <reference types="jest" />
import { ForbiddenException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import {
  ewohSchedulingPolicy,
  ewohMaintenanceCondition,
  ewohQualityFinding,
} from '@server/database/schema';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { KpiService } from '../kpi.service';
import { ShadowPolicyService } from '../shadow-policy.service';
import { ResourceProjectionService } from '../resource-projection.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';
import type { RequestDatabaseContext } from '../../../database/request-database-context';

/**
 * 从 drizzle SQL 谓词中递归抽取 (columnName, value) eq 对——用于链式 fake
 * 按 where 条件过滤行（ColumnName 取 pg 列名：org_id / config_version 等）。
 */
function extractEqPairs(sql: unknown, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  const chunk = sql as { queryChunks?: unknown[]; name?: string; encoder?: unknown; value?: unknown } | undefined;
  if (!chunk || typeof chunk !== 'object') return out;
  if (Array.isArray(chunk.queryChunks)) {
    let pendingName: string | undefined;
    for (const c of chunk.queryChunks) {
      const cc = c as { name?: string; encoder?: unknown; value?: unknown; queryChunks?: unknown[] } | undefined;
      if (cc && typeof cc.name === 'string' && !('encoder' in cc)) {
        pendingName = cc.name;
        continue;
      }
      if (cc && 'encoder' in cc && 'value' in cc && pendingName) {
        out.push([pendingName, cc.value]);
        pendingName = undefined;
        continue;
      }
      extractEqPairs(c, out);
    }
    return out;
  }
  return out;
}

/** 行过滤：按抽取的 eq 对匹配（列名 → 行属性驼峰映射）。 */
function rowMatches(row: Record<string, unknown>, pairs: Array<[string, unknown]>): boolean {
  const camel = (col: string) =>
    col.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  for (const [col, value] of pairs) {
    const key = camel(col);
    if (row[key] !== value) return false;
  }
  return true;
}

/** 链式 select fake：where 谓词真实过滤（eq 对），limit/orderBy 直通。 */
function chainSelect(rows: Array<Record<string, unknown>>): any {
  const build = (filtered: Array<Record<string, unknown>>): any => {
    const q: any = {
      where: (pred: SQL) => build(filtered.filter((r) => rowMatches(r, extractEqPairs(pred)))),
      orderBy: () => build(filtered),
      limit: (n?: number) => Promise.resolve(filtered.slice(0, n ?? filtered.length)),
      then: (resolve: (v: unknown) => void) => resolve(filtered),
    };
    return q;
  };
  return build(rows);
}

// ===========================================================================
// R2-SSV-01：scheduling-policy 版本读写面 org 条件 + 激活不改写 orgId
// ===========================================================================
describe('R2-SSV-01: scheduling-policy 版本读写 org 作用域', () => {
  const ROW_A = {
    id: 'policy-a',
    configVersion: 2,
    orgId: 'orgA',
    active: false,
    configJson: { configVersion: 2, minBatteryPct: 11 },
    weightsJson: null,
  };
  const ROW_B = {
    id: 'policy-b',
    configVersion: 2,
    orgId: 'orgB',
    active: false,
    configJson: { configVersion: 2, minBatteryPct: 22 },
    weightsJson: null,
  };

  function makeSvc(rows: Array<Record<string, unknown>> = [ROW_A, ROW_B]) {
    const updates: Array<{ set: Record<string, unknown>; wherePairs: Array<[string, unknown]> }> = [];
    const db: any = {
      select: () => ({ from: (table: unknown) => chainSelect(table === ewohSchedulingPolicy ? rows : []) }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (pred: SQL) => {
            if (table === ewohSchedulingPolicy) updates.push({ set: patch, wherePairs: extractEqPairs(pred) });
            return Promise.resolve();
          },
        }),
      }),
      insert: () => ({ values: () => Promise.resolve() }),
    };
    return { svc: new SchedulingPolicyService(db), updates, db };
  }

  it('getConfigByVersion 带 orgId 只读本 org 行（他租户同版本号行不可见）', async () => {
    const { svc } = makeSvc();
    await expect(svc.getConfigByVersion(2, 'orgA')).resolves.toMatchObject({ minBatteryPct: 11 });
    await expect(svc.getConfigByVersion(2, 'orgB')).resolves.toMatchObject({ minBatteryPct: 22 });
  });

  it('getPolicy 无 org 时保持原语义（系统流，GUC/RLS 兜底）', async () => {
    const { svc } = makeSvc([ROW_A]);
    await expect(svc.getPolicy(2)).resolves.toMatchObject({ version: 2 });
  });

  it('activatePolicyVersion 的 UPDATE 不改写行 orgId 且 where 叠加 org 可见性', async () => {
    const { svc, updates } = makeSvc();
    await svc.activatePolicyVersion(2, 'orgA', 'admin');
    const activateUpdate = updates.find((u) => u.set.active === true);
    expect(activateUpdate).toBeDefined();
    // 关键断言 1：set 不含 orgId（绝不改写行归属）。
    expect(activateUpdate!.set).not.toHaveProperty('orgId');
    // 关键断言 2：where 含 org 可见性条件（org_id = orgA）。
    expect(activateUpdate!.wherePairs).toContainEqual(['org_id', 'orgA']);
  });

  it('activatePolicyVersion org 作用域内找不到他租户版本 → 404', async () => {
    const { svc } = makeSvc([ROW_B]);
    await expect(svc.activatePolicyVersion(2, 'orgA', 'admin')).rejects.toThrow(/not found/);
  });
});

// ===========================================================================
// R2-SSV-02：kpi aggregateForPolicyEvaluation orgId 透传
// ===========================================================================
describe('R2-SSV-02: aggregateForPolicyEvaluation org 作用域', () => {
  function makeKpi() {
    const executionService = { listAll: jest.fn().mockResolvedValue([]) };
    const feedbackService = { deriveKpis: jest.fn().mockResolvedValue({}) };
    const conflictService = { listConflicts: jest.fn().mockResolvedValue({ conflicts: [] }) };
    const svc = new KpiService(
      {} as never,
      executionService as never,
      feedbackService as never,
      conflictService as never,
    );
    return { svc, executionService };
  }

  it('传 orgId → aggregate({orgId}) 按 org 聚合（execution.listAll 收到 orgId）', async () => {
    const { svc, executionService } = makeKpi();
    const kpi = await svc.aggregateForPolicyEvaluation('org1');
    expect(kpi).toMatchObject({ onTimeRate: null, latenessP95Ms: null });
    expect(executionService.listAll).toHaveBeenCalledWith('org1');
  });

  it('系统上下文（无 HTTP request context）orgId 缺省 → 全量系统语义（listAll(null)）', async () => {
    const { svc, executionService } = makeKpi();
    await svc.aggregateForPolicyEvaluation(null);
    expect(executionService.listAll).toHaveBeenCalledWith(null);
  });
});

// ===========================================================================
// R2-SSV-03：shadow plan 落库与 isShadow 标记同事务原子化
// ===========================================================================
describe('R2-SSV-03: shadow plan isShadow 标记原子化', () => {
  function makeShadowDeps(opts: { markFails?: boolean } = {}) {
    const calls: string[] = [];
    const deletedPlanIds: string[] = [];
    const markedPlanIds: string[] = [];
    const policyRows = [
      { configVersion: 2, orgId: 'org1', status: 'SHADOW', active: false, configJson: {}, weightsJson: null },
    ];
    const db: any = {
      select: () => ({
        from: (table: unknown) =>
          chainSelect(table === ewohSchedulingPolicy ? policyRows : []),
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            if (patch.isShadow === true) {
              if (opts.markFails) return Promise.reject(new Error('mark boom'));
              markedPlanIds.push('marked');
              calls.push('mark-shadow');
            }
            return Promise.resolve();
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: () => {
          if (String(table).includes('ewohSchedulePlan') || table) {
            deletedPlanIds.push('deleted');
            calls.push('delete-plan');
          }
          return Promise.resolve();
        },
      }),
    };
    const worldStateSnapshotService = {
      buildSnapshot: jest.fn().mockResolvedValue({ snapshotVersion: 'WS-1' }),
    };
    const planStub = { planId: 'SHADOW-2-1', assignments: [], violations: [], trigger: { type: 'MANUAL', entityId: null } };
    const solverService = {
      solveVariants: jest.fn().mockResolvedValue([planStub]),
    };
    const planService = {
      persistPlan: jest.fn(async () => {
        calls.push('persist-plan');
        return planStub;
      }),
    };
    const planCompareService = { compare: jest.fn().mockReturnValue({ churn: 0 }) };
    const metricsService = { recordPolicyEvent: jest.fn() };
    const outboxService = { enqueue: jest.fn().mockResolvedValue({}) };
    return { db, calls, deletedPlanIds, markedPlanIds, worldStateSnapshotService, solverService, planService, planCompareService, metricsService, outboxService };
  }

  function makeSvc(deps: ReturnType<typeof makeShadowDeps>, tx?: { runInTransaction: jest.Mock }) {
    return new ShadowPolicyService(
      deps.db,
      deps.worldStateSnapshotService as never,
      deps.solverService as never,
      deps.planService as never,
      deps.planCompareService as never,
      deps.metricsService as never,
      deps.outboxService as never,
      undefined,
      tx as unknown as RequestDatabaseContext | undefined,
    );
  }

  it('有 RequestDatabaseContext：persistPlan 与 isShadow 标记在同一事务回调内执行', async () => {
    const deps = makeShadowDeps();
    const tx = {
      runInTransaction: jest.fn(async (_g: unknown, cb: () => Promise<void>) => {
        deps.calls.push('tx-begin');
        await cb();
        deps.calls.push('tx-end');
      }),
    };
    const svc = makeSvc(deps, tx);
    await svc.generateShadowPlan(2, { userId: 'u1', primaryOrgId: 'org1' });
    // persist 与 mark 都发生在 tx-begin 与 tx-end 之间（同事务原子）。
    // T12（2026-08-28）：generateShadowPlan 尾部新增惰性 shadow 方案清理
    // （maybePruneShadowPlans），fire-and-forget、不进入该事务，会在序列
    // 尾部追加一次 delete-plan；前缀断言仍覆盖原子性意图。
    expect(deps.calls.slice(0, 4)).toEqual(['tx-begin', 'persist-plan', 'mark-shadow', 'tx-end']);
    expect(deps.calls.slice(4)).toEqual(['delete-plan']);
    expect(deps.markedPlanIds).toEqual(['marked']);
  });

  it('无事务上下文且标记失败：补偿删除 plan 行，绝不留可审批的裸 shadow 方案', async () => {
    const deps = makeShadowDeps({ markFails: true });
    const svc = makeSvc(deps, undefined);
    await expect(
      svc.generateShadowPlan(2, { userId: 'u1', primaryOrgId: 'org1' }),
    ).rejects.toThrow('mark boom');
    expect(deps.calls).toContain('persist-plan');
    expect(deps.calls).toContain('delete-plan');
    expect(deps.deletedPlanIds).toEqual(['deleted']);
  });
});

// ===========================================================================
// R2-SSV-04：resource-projection 维护/质量事实 org 过滤
// ===========================================================================
describe('R2-SSV-04: 维护/质量附着 org 过滤', () => {
  function makeProjection() {
    const personnel = [
      { id: 'p1', orgId: 'org1', name: 'P1', employeeNo: 'E1', skills: [], certifications: [], updatedAt: new Date(), status: 'available', spatialEntityId: null, currentLoad: null, version: 1 },
    ];
    const maintenance = [
      { orgId: 'org1', conditionId: 'MC-ORG1', subjectEntityId: 'person:p1', subjectKind: 'person', conditionType: 'maintenance', severity: 'medium', status: 'active', dueAt: null },
      { orgId: 'org2', conditionId: 'MC-ORG2', subjectEntityId: 'person:p1', subjectKind: 'person', conditionType: 'maintenance', severity: 'medium', status: 'active', dueAt: null },
    ];
    const quality = [
      { orgId: 'org1', findingId: 'QF-ORG1', findingType: 'surface', severity: 'medium', status: 'open', links: ['person:p1'], detectedAt: new Date(), disposition: null },
      { orgId: 'org2', findingId: 'QF-ORG2', findingType: 'surface', severity: 'medium', status: 'open', links: ['person:p1'], detectedAt: new Date(), disposition: null },
    ];
    const tables = new Map<unknown, Array<Record<string, unknown>>>([
      [ewohMaintenanceCondition, maintenance],
    ]);
    const db: any = {
      select: () => ({
        from: (table: unknown) => {
          if (table === ewohMaintenanceCondition) return chainSelect(maintenance);
          if (table === ewohQualityFinding) return chainSelect(quality);
          // personnel/device/spatial 三表查询形状由 NEST-102 既有测试覆盖；
          // 此处直接按 org 过滤 personnel（同 eq 语义）。
          return chainSelect(table ? personnel.filter((p) => p.orgId === 'org1') : []);
        },
      }),
    };
    const reservationService = { listActive: jest.fn().mockResolvedValue([]) };
    const svc = new ResourceProjectionService(db, reservationService as never);
    return { svc };
  }

  it('ctx 携带 org1：仅本 org 维护/质量事实附着（org2 事实不跨租户附着）', async () => {
    const { svc } = makeProjection();
    const states = await svc.project({ userId: 'u1', primaryOrgId: 'org1' } as never);
    const person = states.find((s) => s.entityId === 'person:p1');
    expect(person).toBeDefined();
    expect(person!.maintenance?.map((m) => m.conditionId)).toEqual(['MC-ORG1']);
    expect(person!.qualityFindings?.map((q) => q.findingId)).toEqual(['QF-ORG1']);
  });

  it('ctx 缺省（系统后台流）：保持全量系统语义（两 org 事实均附着）', async () => {
    const { svc } = makeProjection();
    const states = await svc.project(undefined);
    const person = states.find((s) => s.entityId === 'person:p1');
    expect(person!.maintenance?.map((m) => m.conditionId).sort()).toEqual(['MC-ORG1', 'MC-ORG2']);
    expect(person!.qualityFindings?.map((q) => q.findingId).sort()).toEqual(['QF-ORG1', 'QF-ORG2']);
  });
});

// ===========================================================================
// R2-SSV-05 / R2-SSV-13：feedback 推进 CAS + 受派者授权
// ===========================================================================
describe('R2-SSV-13: recordActuals 状态推进受派者/可信角色授权', () => {
  function buildService(seed: Parameters<typeof makeFakeDb>[0] = {}) {
    const { db, state } = makeFakeDb(seed);
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const svc = new SchedulingFeedbackService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
    );
    return { svc, db, state };
  }

  const seedDispatched = () => ({
    assignments: [
      {
        assignmentId: 'ASG-1',
        planId: 'PLAN-1',
        taskId: 'TASK-1',
        personId: 'p1',
        deviceId: null,
        stationId: null,
        status: 'dispatched',
        orgId: 'org1',
      },
    ],
  });

  it('非受派者（userId ≠ personId、无可信角色）推进 dispatched assignment → 403', async () => {
    const { svc } = buildService(seedDispatched());
    await expect(
      svc.recordActuals(
        { assignmentId: 'ASG-1', actualStart: '2026-08-17T08:00:00Z' },
        { userId: 'intruder', primaryOrgId: 'org1' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('受派人本人（userId === personId）回填 → 推进成功', async () => {
    const { svc, state } = buildService(seedDispatched());
    const res = await svc.recordActuals(
      { assignmentId: 'ASG-1', actualStart: '2026-08-17T08:00:00Z' },
      { userId: 'p1', primaryOrgId: 'org1' },
    );
    expect(res.advancedAssignments).toBe(1);
    expect(state.assignments[0].status).toBe('executing');
  });

  it('dispatcher 可信角色代录 → 推进成功', async () => {
    const { svc } = buildService(seedDispatched());
    const res = await svc.recordActuals(
      { assignmentId: 'ASG-1', actualEnd: '2026-08-17T08:30:00Z' },
      { userId: 'dispatcher-1', primaryOrgId: 'org1', role: 'dispatcher' },
    );
    expect(res.advancedAssignments).toBe(1);
  });

  it('无可推进 assignment（非 dispatched/executing）→ 不触发授权拦截', async () => {
    const { svc } = buildService({
      assignments: [{ ...seedDispatched().assignments[0], status: 'proposed' }],
    });
    const res = await svc.recordActuals(
      { assignmentId: 'ASG-1', actualStart: '2026-08-17T08:00:00Z' },
      { userId: 'intruder', primaryOrgId: 'org1' },
    );
    expect(res.advancedAssignments).toBe(0);
  });
});

describe('R2-SSV-05: applyExecutionAdvancement CAS 0 命中不发事件', () => {
  it('并发后到者 CAS miss → 不插 assignment 事件、不计推进', async () => {
    const { db, state } = makeFakeDb(seedR2Ssv05());
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    // 覆盖 assignment UPDATE：CAS 谓词未命中（并发已推进）→ returning []。
    (db as { update: unknown }).update = () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    });
    const svc = new SchedulingFeedbackService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
    );
    const res = await svc.recordActuals(
      { assignmentId: 'ASG-1', actualStart: '2026-08-17T08:00:00Z' },
      testOrgContext(),
    );
    expect(res.advancedAssignments).toBe(0);
    expect(res.skips).toEqual(expect.arrayContaining([expect.stringContaining('start_cas_miss')]));
    expect(state.events).toHaveLength(0);
  });

  function seedR2Ssv05(): Parameters<typeof makeFakeDb>[0] {
    return {
      assignments: [
        {
          assignmentId: 'ASG-1',
          planId: 'PLAN-1',
          taskId: 'TASK-1',
          personId: 'u1',
          deviceId: null,
          stationId: null,
          status: 'dispatched',
          orgId: 'org1',
        },
      ],
    };
  }
});
