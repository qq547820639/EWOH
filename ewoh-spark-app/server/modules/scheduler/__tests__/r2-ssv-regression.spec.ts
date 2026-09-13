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
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { makeCanonicalReceiptHarness } from './canonical-receipt-test-harness';
import type { SQL } from 'drizzle-orm';
import {
  ewohSchedulingPolicy,
  ewohSchedulingPlanAssignment,
  ewohMaintenanceCondition,
  ewohQualityFinding,
} from '@server/database/schema';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { KpiService } from '../kpi.service';
import { ShadowPolicyService } from '../shadow-policy.service';
import { ResourceProjectionService } from '../resource-projection.service';
import { testOrgContext } from './dispatch-test-harness';
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
// Canonical receipt regression: authorization, CAS/lock failure and conjunctive matching.
// ===========================================================================
describe('canonical receipt authorization and concurrency invariants', () => {
  it('non-assignee cannot advance a receipt', async () => {
    const h = makeCanonicalReceiptHarness({ personId: 'worker-1' });
    await expect(h.feedback.recordActuals({ assignmentId: h.assignmentId, actualStart: '2026-08-17T08:00:00Z' }, { userId: 'intruder', primaryOrgId: 'org1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.state.assignments[0].status).toBe('dispatched'); expect(h.state.feedback).toHaveLength(0);
  });
  it('assignee and dispatcher are both accepted by the canonical path', async () => {
    const worker = makeCanonicalReceiptHarness(); await worker.feedback.recordActuals({ assignmentId: worker.assignmentId, actualStart: '2026-08-17T08:00:00Z' }, worker.actor); expect(worker.state.assignments[0].status).toBe('executing');
    const dispatcher = makeCanonicalReceiptHarness(); await dispatcher.feedback.recordActuals({ assignmentId: dispatcher.assignmentId, actualStart: '2026-08-17T08:00:00Z' }, { userId: 'dispatcher', primaryOrgId: 'org1', role: 'dispatcher' }); expect(dispatcher.state.assignments[0].status).toBe('executing');
  });
  it('CAS loss aborts writes and emits no assignment event', async () => {
    const h = makeCanonicalReceiptHarness(); h.faults.casMiss = ewohSchedulingPlanAssignment;
    await expect(h.feedback.recordActuals({ assignmentId: h.assignmentId, actualStart: '2026-08-17T08:00:00Z' }, h.actor)).rejects.toBeInstanceOf(ConflictException);
    expect(h.state.events).toHaveLength(0); expect(h.state.outbox).toHaveLength(0); expect(h.state.executions[0].status).toBe('DISPATCHED');
  });
  /**
   * 2026-09-10 回归：回执的"本人可报"必须比较**同一标识空间**。
   *
   * 旧实现 `assignment.personId !== ctx.userId` 比较人员域与登录账号域，于是
   * 现场 worker 永远回执不了自己的任务，只能借特权角色。以下三个用例把修复
   * 钉死：绑定匹配才放行、未绑定 fail-closed、登录 id 与人员 id 相同也不算数。
   */
  it('账号已绑定该人员 → 允许本人回执', async () => {
    const h = makeCanonicalReceiptHarness({ personId: 'worker-1', actorUserId: 'acct-1' });
    await h.feedback.recordActuals(
      { assignmentId: h.assignmentId, actualStart: '2026-08-17T08:00:00Z' },
      { userId: 'acct-1', primaryOrgId: 'org1', personId: 'worker-1' },
    );
    expect(h.state.assignments[0].status).toBe('executing');
  });

  it('账号未绑定人员（即使 userId 恰好等于 personId）→ fail-closed 拒绝', async () => {
    const h = makeCanonicalReceiptHarness({ personId: 'worker-1' });
    await expect(h.feedback.recordActuals(
      { assignmentId: h.assignmentId, actualStart: '2026-08-17T08:00:00Z' },
      // 这正是旧实现赖以通过的形状：userId === assignment.personId，但无绑定事实。
      { userId: 'worker-1', primaryOrgId: 'org1', personId: null },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.state.assignments[0].status).toBe('dispatched');
  });

  it('账号绑定的是别人 → 拒绝（不能回执他人任务）', async () => {
    const h = makeCanonicalReceiptHarness({ personId: 'worker-1' });
    await expect(h.feedback.recordActuals(
      { assignmentId: h.assignmentId, actualStart: '2026-08-17T08:00:00Z' },
      { userId: 'acct-2', primaryOrgId: 'org1', personId: 'worker-2' },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.state.assignments[0].status).toBe('dispatched');
  });

  it('cross-key mismatch is conjunctive and cannot broaden to another assignment', async () => {
    const h = makeCanonicalReceiptHarness(); h.state.assignments.push({ ...h.state.assignments[0], id: 'assignment-row-2', assignmentId: 'ASG-OTHER', taskId: 'other-task' });
    await expect(h.canonical.applyFromActuals({ assignmentId: h.assignmentId, taskId: 'other-task', actualStart: '2026-08-17T08:00:00Z' }, h.actor)).resolves.toBeNull();
    expect(h.state.assignments.every(a => a.status === 'dispatched')).toBe(true);
  });
});
