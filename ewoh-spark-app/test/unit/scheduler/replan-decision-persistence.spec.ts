/* replan-decision-persistence.spec.ts — Replan Decision 台账持久化（NO-13m / ADR-062）。
 *
 * handleTrigger 产方案后：replan 决策（Decision Catalog kind #6）经
 * decision-ledger 单一实现追加进新方案 decision_records_json；
 * 投影缺口/追加失败 log 显式不阻断重排主流程（§2/§33）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../../../server/modules/scheduler/replan-coordinator.service';
import { validateDecision } from '@shared/decision';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { buildSnapshot, person, task } from '../../../server/modules/scheduler/__tests__/scheduler-test-helpers';

function makeReplanFlow() {
  const snapshot: WorldStateSnapshot = buildSnapshot({
    persons: [person({ id: 'p1' })],
    tasks: [{ ...task({ id: 't-1' }), deviceId: 'd1' }],
  });

  // 方案台账行（persistPlan 落一行；decision_records_json 由 ledger 追加）。
  const planRows = new Map<string, Record<string, unknown>>();

  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => {
        const q: any = Promise.resolve(Array.from(planRows.values()));
        q.where = () => {
          const q2: any = Promise.resolve(Array.from(planRows.values()));
          q2.orderBy = () => q2;
          q2.limit = () => Promise.resolve(Array.from(planRows.values()).slice(0, 1));
          return q2;
        };
        q.orderBy = () => q;
        q.limit = () => Promise.resolve(Array.from(planRows.values()).slice(0, 1));
        return q;
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn(() => {
          for (const row of planRows.values()) Object.assign(row, patch);
          // 真实 drizzle 构建器**既可 await 又带 .returning()**；`closeRun` 用后者判 0 行命中，
          // 替身不同形就会把每次正常闭合都读成"未命中"（本仓库记过名的替身形状漂移）。
          const hit = [{ runId: 'RUN-1' }];
          return Object.assign(Promise.resolve(hit), { returning: () => Promise.resolve(hit) });
        }),
      })),
    })),
  };

  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, fn: () => Promise<unknown>) => fn()),
  };
  const triggerService = {
    evaluate: jest.fn().mockResolvedValue({
      runId: 'RUN-1',
      triggerType: 'DEVICE_OFFLINE',
      triggerEntityId: 'd1',
      status: 'queued',
      snapshotVersion: null,
      planIds: [],
      orgId: 'org1',
      error: null,
      createdAt: new Date().toISOString(),
    }),
  };
  const worldStateSnapshotService = {
    buildSnapshot: jest.fn().mockResolvedValue(snapshot),
  };
  const plan = {
    planId: 'RUN-1A',
    version: 1,
    status: 'shadow',
    trigger: { type: 'DEVICE_OFFLINE', entityId: 'd1' },
    snapshotVersion: 'WS-TEST-0001',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [],
    metrics: {},
    baselineDelta: {},
    violations: [],
    createdAt: new Date().toISOString(),
  };
  const solverService = { solveVariants: jest.fn().mockResolvedValue([plan]) };
  const planService = {
    persistPlan: jest.fn(async (p: { planId: string }) => {
      planRows.set(p.planId, { planId: p.planId, decisionRecordsJson: [] });
    }),
  };
  const policyService = {
    getConfig: jest.fn().mockResolvedValue({
      configVersion: 1,
      triggerCooldownMs: 30_000,
      priority: {},
      replan: {
        replanDebounceMs: 5_000,
        minimumReplanIntervalMs: 30_000,
        maximumReplansPerWindow: 12,
        conflictAggregationWindowMs: 60_000,
        maxPropagationDepth: 3,
        maxAffectedTasks: 200,
      },
    }),
  };
  const svc = new ReplanCoordinatorService(
    db as never,
    requestDatabaseContext as never,
    triggerService as never,
    worldStateSnapshotService as never,
    solverService as never,
    planService as never,
    policyService as never,
  );
  return { svc, planRows };
}

describe('Replan Decision 台账持久化（NO-13m / ADR-062：kind #6）', () => {
  it('handleTrigger 产方案 → 新方案决策台账含 replan 记录（契约门内 + 判定事实）', async () => {
    const { svc, planRows } = makeReplanFlow();
    const result = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });
    expect(result.plans).toHaveLength(1);
    expect(planRows.has('RUN-1A')).toBe(true);
    const records = planRows.get('RUN-1A')?.decisionRecordsJson as Array<Record<string, unknown>>;
    expect(Array.isArray(records)).toBe(true);
    const replanRecords = records.filter((r) => r.kind === 'replan');
    expect(replanRecords).toHaveLength(1);
    const record = replanRecords[0];
    expect(record.decisionId).toBe('decision:RUN-1A:replan');
    expect(record.status).toBe('proposed');
    expect(record.decisionAuthority).toBe('policy');
    expect(record.riskLevel).toBe('medium'); // DEVICE_OFFLINE 类型推导规则
    expect(record.requiresApproval).toBe(true);
    expect(validateDecision(record)).toEqual([]);
    expect(record.subject).toBe('plan:RUN-1A');
  });

  it('重复触发（同 run 去抖）不重复追加——decisionId 确定性幂等', async () => {
    const { svc, planRows } = makeReplanFlow();
    // 第一次触发。
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', { userId: 'u1', primaryOrgId: 'org1' });
    const after = (planRows.get('RUN-1A')?.decisionRecordsJson as Array<Record<string, unknown>>) ?? [];
    const replanCount = after.filter((r) => r.kind === 'replan').length;
    expect(replanCount).toBe(1);
    // 第二次触发被去抖/守卫合并（evaluate 仍被调用但方案不重持久化——decisionId 幂等）。
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', { userId: 'u1', primaryOrgId: 'org1' });
    const after2 = (planRows.get('RUN-1A')?.decisionRecordsJson as Array<Record<string, unknown>>) ?? [];
    expect(after2.filter((r) => r.kind === 'replan').length).toBe(replanCount);
  });
});
