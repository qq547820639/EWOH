/* Phase 1 / P1-E（§九）：人工干预版本 CAS 单测。
 *
 * 覆盖：
 * - override 应用带旧 expectedPlanVersion → STALE_PLAN 拒绝（不落库、不重排）
 * - override 应用带旧 expectedSnapshotVersion → STALE_SNAPSHOT 拒绝
 * - override 应用匹配（expected* 与当前一致）→ 正常
 * - override 应用无入参 → 兼容现状（向后兼容）
 * - approve 带旧 expectedSnapshotVersion → STALE_SNAPSHOT 拒绝
 * - approve 带旧 expectedPlanVersion → STALE_PLAN 拒绝
 * - approve 匹配/无入参 → 正常（向后兼容）
 */
/// <reference types="jest" />
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';
import {
  makeSolver,
  buildSnapshot,
  person,
  task,
  device,
  defaultPolicy,
  defaultConfig,
} from './scheduler-test-helpers';
import { PlanService } from '../plan.service';
import { SchedulerService } from '../scheduler.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { RoutingService } from '../routing.service';
import { RouteCostProvider } from '../route-cost.provider';
import { EligibilityService } from '../eligibility.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { TriggerService } from '../trigger.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { AuditService } from '@server/modules/shared/audit.service';
import type { PlanOverrideRequest } from '@shared/api.interface';

/** 构造 SchedulerService + PlanService + 真实求解器（CP-SAT 失败回退启发式）+ 内存 fake DB。 */
function makeScheduler(
  seed: Parameters<typeof makeFakeDb>[0],
  snapshotOverrides: Parameters<typeof buildSnapshot>[0] = {},
) {
  const { db, state } = makeFakeDb(seed);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = {
    appendAuditLog: jest.fn().mockResolvedValue(undefined),
  };

  const snapshot = buildSnapshot({
    persons: [
      person({ id: 'p1', skills: ['work'] }),
      person({ id: 'p2', skills: ['work'] }),
    ],
    tasks: [
      task({
        id: 't1',
        taskType: 'work',
        priority: 'medium',
        status: 'pending',
        requiredSkills: ['work'],
      }),
    ],
    devices: [device({ id: 'd1' })],
    ...snapshotOverrides,
  });

  const worldStateSnapshotService = {
    buildSnapshot: jest.fn().mockResolvedValue(snapshot),
    getCurrentWorldState: jest.fn().mockResolvedValue(snapshot),
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
  };

  const { solver, routing, policy, routeCostProvider } = makeSolver();
  // 扩展策略 mock，供 planService.replan 解析策略版本。
  (policy as Record<string, unknown>).getPolicy = jest
    .fn()
    .mockResolvedValue(defaultPolicy());
  (policy as Record<string, unknown>).getConfigByVersion = jest
    .fn()
    .mockResolvedValue(defaultConfig());

  const schedulingPolicyService = policy as unknown as SchedulingPolicyService;
  const constraintLoaderService = {
    loadForPlan: jest.fn(async (_planId: string, requestConstraints: any[]) => {
      return requestConstraints;
    }),
    hashConstraints: jest.fn((cs: unknown[]) => JSON.stringify(cs)),
  };
  const planService = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solver,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    { dispatch: jest.fn() } as never,
    schedulingPolicyService,
    { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn().mockResolvedValue(undefined) } as never,
    constraintLoaderService as never,
    { enqueue: jest.fn().mockResolvedValue({ id: 'evt', eventType: 'stale_plan', entityId: 'x', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() }) } as never,
    { handleTrigger: jest.fn() } as never,
  );

  const schedulerService = new SchedulerService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    { evaluate: jest.fn() } as unknown as TriggerService,
    solver,
    planService,
    routing as unknown as RoutingService,
    new EligibilityService(),
    routeCostProvider as unknown as RouteCostProvider,
    schedulingPolicyService,
    { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
    { enqueue: jest.fn() } as never,
  );

  return { schedulerService, planService, db, state, snapshot };
}

const seedPlan = (status = 'proposed', overrides: Record<string, unknown> = {}) => ({
  planId: 'P1',
  planName: 'base',
  status,
  version: 1,
  snapshotVersion: 'WS-TEST-0001',
  horizonMinutes: 480,
  createdAt: new Date(),
  ...overrides,
});

const overrideBody = (
  extra: Partial<Pick<PlanOverrideRequest, 'expectedPlanVersion' | 'expectedSnapshotVersion'>> = {},
): PlanOverrideRequest => ({
  actions: [{ kind: 'BOOST' as const, taskId: 't1' }],
  operator: 'op1',
  reason: '人工干预',
  ...extra,
});

describe('P1-E: override 应用版本 CAS（STALE_PLAN / STALE_SNAPSHOT）', () => {
  it('旧 expectedPlanVersion → STALE_PLAN 拒绝，且不落库不重排', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan()] });

    await expect(
      schedulerService.applyOverrides(
        'P1',
        overrideBody({ expectedPlanVersion: 99 }),
        testOrgContext(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('STALE_PLAN'),
    });
    // 无约束落库、方案状态未变（不自动应用）。
    expect(state.constraints).toHaveLength(0);
    expect(state.plans.get('P1')?.status).toBe('proposed');
  });

  it('旧 expectedSnapshotVersion → STALE_SNAPSHOT 拒绝，且不落库不重排', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan()] });

    await expect(
      schedulerService.applyOverrides(
        'P1',
        overrideBody({ expectedSnapshotVersion: 'WS-OLD-0001' }),
        testOrgContext(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('STALE_SNAPSHOT'),
    });
    expect(state.constraints).toHaveLength(0);
  });

  it('expected* 与当前一致 → 正常应用（重排产出新方案）', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan()] });

    const res = await schedulerService.applyOverrides(
      'P1',
      overrideBody({
        expectedPlanVersion: 1,
        expectedSnapshotVersion: 'WS-TEST-0001',
      }),
      testOrgContext(),
    );

    expect(res.after.planId).toBe('P1-R2');
    expect(state.constraints.length).toBeGreaterThan(0);
  });

  it('无 expected* 入参 → 兼容现状（向后兼容，正常应用）', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan()] });

    const res = await schedulerService.applyOverrides(
      'P1',
      overrideBody(),
      testOrgContext(),
    );

    expect(res.after.planId).toBe('P1-R2');
    expect(state.plans.get('P1')?.status).toBe('superseded');
  });

  it('expectedPlanVersion 匹配但 expectedSnapshotVersion 过期 → STALE_SNAPSHOT（先版本后快照顺序）', async () => {
    const { schedulerService } = makeScheduler({ plans: [seedPlan()] });

    await expect(
      schedulerService.applyOverrides(
        'P1',
        overrideBody({
          expectedPlanVersion: 1,
          expectedSnapshotVersion: 'WS-OLD-0001',
        }),
        testOrgContext(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('STALE_SNAPSHOT'),
    });
  });
});

describe('P1-E: approve 版本 CAS（STALE_PLAN / STALE_SNAPSHOT）', () => {
  it('旧 expectedSnapshotVersion（与请求 snapshotVersion 不一致）→ STALE_SNAPSHOT 拒绝', async () => {
    const { schedulerService } = makeScheduler({ plans: [seedPlan('proposed')] });

    await expect(
      schedulerService.approvePlanV2(
        'P1',
        {
          version: 1,
          snapshotVersion: 'WS-TEST-0001',
          expectedSnapshotVersion: 'WS-OLD-0001',
          operator: 'op1',
          reason: 'approve',
        },
        testOrgContext(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('STALE_SNAPSHOT'),
    });
  });

  it('旧 expectedPlanVersion（与请求 version 不一致）→ STALE_PLAN 拒绝', async () => {
    const { schedulerService } = makeScheduler({ plans: [seedPlan('proposed')] });

    await expect(
      schedulerService.approvePlanV2(
        'P1',
        {
          version: 1,
          snapshotVersion: 'WS-TEST-0001',
          expectedPlanVersion: 99,
          operator: 'op1',
          reason: 'approve',
        },
        testOrgContext(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('STALE_PLAN'),
    });
  });

  it('expected* 与请求一致 → 正常审批（approved）', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan('proposed')] });

    const res = await schedulerService.approvePlanV2(
      'P1',
      {
        version: 1,
        snapshotVersion: 'WS-TEST-0001',
        expectedPlanVersion: 1,
        expectedSnapshotVersion: 'WS-TEST-0001',
        operator: 'op1',
        reason: 'approve',
      },
      testOrgContext(),
    );

    expect(res.status).toBe('approved');
    expect(state.plans.get('P1')?.status).toBe('approved');
  });

  it('无 expected* 入参 → 兼容现状（向后兼容，正常审批）', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan('proposed')] });

    const res = await schedulerService.approvePlanV2(
      'P1',
      { version: 1, snapshotVersion: 'WS-TEST-0001', operator: 'op1', reason: 'approve' },
      testOrgContext(),
    );

    expect(res.status).toBe('approved');
    expect(state.plans.get('P1')?.status).toBe('approved');
  });

  it('请求 version 过期（plan 当前 version≠请求 version）→ 既有 PLAN_STALE 兜底（不因无 expected* 而退化）', async () => {
    const { schedulerService } = makeScheduler({ plans: [seedPlan('proposed')] });

    await expect(
      schedulerService.approvePlanV2(
        'P1',
        { version: 99, snapshotVersion: 'WS-TEST-0001', operator: 'op1', reason: 'approve' },
        testOrgContext(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('PLAN_STALE'),
    });
  });
});
