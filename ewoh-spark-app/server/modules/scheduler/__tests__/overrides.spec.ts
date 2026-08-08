/* Task 3 集成测试：人工覆盖闭环（cmd-map-scheduling-closed-loop）。
 *
 * 覆盖：
 * - lock → replan → diff（applyOverrides 触发既有 V2 重排并返回 before/after 差异）
 * - EXCLUDED_RESOURCE 被启发式求解器真实执行（资源从候选中排除）
 * - PREFERRED_RESOURCE 提升软评分（偏好资源被选中）
 * - MANUAL_BOOST 被优先级引擎真实执行（加急任务优先级更高）
 * - 不支持的约束返回 UNSUPPORTED_CONSTRAINT 显式错误
 * - 方案不处于可重排状态时被拒绝（PLAN_NOT_REPLANNABLE）
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';
import {
  makeSolver,
  buildSnapshot,
  person,
  task,
  device,
  defaultPolicy,
  defaultConfig,
  baseSolveOpts,
} from './scheduler-test-helpers';
import { computeEffectivePriorityScores } from '../priority-engine';
import { PlanService } from '../plan.service';
import { SchedulerService } from '../scheduler.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { SolverService } from '../solver.service';
import { RoutingService } from '../routing.service';
import { RouteCostProvider } from '../route-cost.provider';
import { EligibilityService } from '../eligibility.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { TriggerService } from '../trigger.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { AuditService } from '@server/modules/shared/audit.service';
import type { PlanOverrideResponse } from '@shared/api.interface';

/** 构造 SchedulerService + PlanService + 真实求解器（CP-SAT 失败回退启发式）+ 内存 fake DB。 */
function makeScheduler(seed: Parameters<typeof makeFakeDb>[0]) {
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
  const planService = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solver,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    { dispatch: jest.fn() } as never,
    schedulingPolicyService,
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

  return { schedulerService, planService, db, state, snapshot, mocks: { policy, auditService, requestDatabaseContext } };
}

const seedPlan = (status = 'proposed') => ({
  planId: 'P1',
  planName: 'base',
  status,
  version: 1,
  snapshotVersion: 'WS-TEST-0001',
  horizonMinutes: 480,
  createdAt: new Date(),
});

describe('applyOverrides（人工覆盖闭环）', () => {
  it('lock → replan → diff：锁定人员后重排并返回 before/after 差异', async () => {
    const { schedulerService, state } = makeScheduler({ plans: [seedPlan()] });

    const res: PlanOverrideResponse = await schedulerService.applyOverrides(
      'P1',
      {
        actions: [
          {
            kind: 'LOCK_PERSON',
            taskId: 't1',
            personId: 'p2',
            reason: '指定人员',
            validFrom: 1000,
            expiresAt: 2000,
          },
        ],
        operator: 'op1',
        reason: '人工锁定',
      },
      testOrgContext(),
    );

    // 重排产出新方案，旧方案被标记 superseded。
    expect(res.after.planId).toBe('P1-R2');
    expect(res.after.version).toBe(2);
    expect(state.plans.get('P1')?.status).toBe('superseded');

    // 锁定生效：t1 分配给 p2。
    const t1 = res.after.assignments.find((a) => a.taskId === 't1');
    expect(t1?.personId).toBe('p2');

    // 差异摘要：t1 进入新增分配（before 为空）。
    expect(res.diff.addedTaskIds).toContain('t1');
    expect(res.diff.metricsDelta).toBeDefined();

    // 约束已落库（富化了 operator/reason/validFrom/expiresAt/snapshotVersion）。
    expect(state.constraints.length).toBeGreaterThan(0);
    const persisted = state.constraints[0] as Record<string, unknown>;
    expect(persisted.planId).toBe('P1');
    expect((persisted.valueJson as Record<string, unknown>).operator).toBe('op1');
    expect((persisted.valueJson as Record<string, unknown>).snapshotVersion).toBe(
      'WS-TEST-0001',
    );
  });

  it('覆盖动作 → 约束类型映射覆盖全部 9 种 kind', async () => {
    const kinds = [
      'LOCK_PERSON',
      'LOCK_DEVICE',
      'LOCK_STATION',
      'LOCK_TIME',
      'LOCK_ASSIGNMENT',
      'EXCLUDE_RESOURCE',
      'PREFER_RESOURCE',
      'BOOST',
      'ADJUST_TIME',
    ] as const;
    const actions = kinds.map((kind) => ({ kind, taskId: 't1' }));
    const { schedulerService } = makeScheduler({ plans: [seedPlan()] });
    const res = await schedulerService.applyOverrides(
      'P1',
      { actions, operator: 'op1' },
      testOrgContext(),
    );
    expect(res.appliedConstraints).toHaveLength(kinds.length);
    const types = res.appliedConstraints.map((c) => c.type);
    expect(types).toContain('LOCKED_PERSON');
    expect(types).toContain('EXCLUDED_RESOURCE');
    expect(types).toContain('PREFERRED_RESOURCE');
    expect(types).toContain('MANUAL_BOOST');
  });

  it('方案不存在 → NotFoundException', async () => {
    const { schedulerService } = makeScheduler({});
    await expect(
      schedulerService.applyOverrides(
        'NOPE',
        { actions: [{ kind: 'BOOST', taskId: 't1' }] },
        testOrgContext(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('方案不处于可重排状态（dispatched/终态）→ PLAN_NOT_REPLANNABLE', async () => {
    const { schedulerService } = makeScheduler({
      plans: [seedPlan('dispatched')],
    });
    await expect(
      schedulerService.applyOverrides(
        'P1',
        { actions: [{ kind: 'BOOST', taskId: 't1' }] },
        testOrgContext(),
      ),
    ).rejects.toMatchObject({ status: 409, message: 'PLAN_NOT_REPLANNABLE' });
  });
});

describe('人工覆盖约束被求解器真实执行', () => {
  it('EXCLUDED_RESOURCE 将资源从候选中排除', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [
        person({ id: 'p1', skills: ['work'] }),
        person({ id: 'p2', skills: ['work'] }),
      ],
      tasks: [
        task({ id: 't1', taskType: 'work', status: 'pending', requiredSkills: ['work'] }),
      ],
    });
    // 排除 p1 → 即便 p1 字典序更前，也只能选 p2。
    const plan = await solver.solve(
      snapshot,
      [{ type: 'EXCLUDED_RESOURCE', taskId: 't1', personId: 'p1' }],
      baseSolveOpts,
    );
    const t1 = plan.assignments.find((a) => a.taskId === 't1');
    expect(t1).toBeDefined();
    expect(t1?.personId).toBe('p2');
  });

  it('PREFERRED_RESOURCE 提升软评分使偏好资源被选中', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [
        person({ id: 'p1', skills: ['work'] }),
        person({ id: 'p2', skills: ['work'] }),
      ],
      tasks: [
        task({ id: 't1', taskType: 'work', status: 'pending', requiredSkills: ['work'] }),
      ],
    });
    // 无偏好时按字典序选 p1；偏好 p2 后 p2 的成本更低 → 选 p2。
    const plan = await solver.solve(
      snapshot,
      [{ type: 'PREFERRED_RESOURCE', taskId: 't1', personId: 'p2' }],
      baseSolveOpts,
    );
    const t1 = plan.assignments.find((a) => a.taskId === 't1');
    expect(t1?.personId).toBe('p2');
  });

  it('MANUAL_BOOST 被优先级引擎真实执行（加急任务更紧急）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1', skills: ['work'] })],
      tasks: [
        task({ id: 't1', taskType: 'work', priority: 'medium', status: 'pending' }),
        task({ id: 't2', taskType: 'work', priority: 'medium', status: 'pending' }),
      ],
    });
    const cpsat = (solver as unknown as { cpSatSolver?: unknown }).cpSatSolver;
    void cpsat;
    const scores = computeEffectivePriorityScores(
      defaultPolicy(),
      defaultConfig(),
      snapshot,
      [{ type: 'MANUAL_BOOST', taskId: 't2' }],
      Date.now(),
      Date.now() + 480 * 60 * 1000,
    );
    // 两任务完全一致，仅 t2 被加急 → t2 的 score 更小（更紧急）。
    expect(scores.get('t2')!).toBeLessThan(scores.get('t1')!);
  });

  it('不支持的约束返回 UNSUPPORTED_CONSTRAINT 显式错误而非静默忽略', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [person({ id: 'p1', skills: ['work'] })],
      tasks: [
        task({ id: 't1', taskType: 'work', status: 'pending', requiredSkills: ['work'] }),
      ],
    });
    const plan = await solver.solve(
      snapshot,
      [{ type: 'GARBAGE_CONSTRAINT' as never, taskId: 't1' }],
      baseSolveOpts,
    );
    expect(
      plan.violations.some((v) => v.type === 'unsupported_constraint'),
    ).toBe(true);
  });
});