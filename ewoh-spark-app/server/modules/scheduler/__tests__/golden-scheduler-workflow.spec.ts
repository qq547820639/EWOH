/* Golden Scheduler Workflow TCK（Phase 7 / NO-07b，TS 执行器）。
 *
 * 与 tests/test_golden_scheduler_workflow.py 消费同一份共享场景定义
 * （tests/golden-fixtures/scheduler-workflow-golden.json）：
 * - 本文件：真实 PlanService（审批 CAS 双校验）+ 真实 ResourceReservationService
 *   （预约重叠冲突）+ 真实 DispatchCoordinatorService（派工前置/状态/事件链）
 *   在状态化 fake-db 替身上执行操作序列，规范化结果与提交的
 *   scheduler-workflow-golden-results.json 零漂移比对；
 * - Python 侧：标准库重实现工作流不变量（plan 版本 CAS / 预约重叠冲突 /
 *   派工前置条件）对同一结果独立仲裁。
 *
 * 外设 mock（outbox/task/audit/worldState 新鲜度断言）仅覆盖非不变量外设；
 * 不变量载体（CAS 状态机/冲突判定/事件写入/任务绑定）为真实服务代码。
 * 更新结果：UPDATE_GOLDEN_WORKFLOW_RESULTS=1。
 */
/// <reference types="jest" />
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConflictException } from '@nestjs/common';
import { DispatchCoordinatorService } from '../dispatch-coordinator.service';
import { PlanService } from '../plan.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { WorldStateSnapshotService } from '../world-state.service';
import { ResourceReservationService } from '../resource-reservation.service';
import { OutboxService } from '../outbox.service';
import { AuditService } from '@server/modules/shared/audit.service';
import { TaskService } from '@server/modules/task/task.service';
import { SolverService } from '../solver.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';
import { makeSolver, defaultPolicy, defaultConfig } from './scheduler-test-helpers';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SCENARIOS_PATH = path.join(REPO_ROOT, 'tests', 'golden-fixtures', 'scheduler-workflow-golden.json');
const RESULTS_PATH = path.join(REPO_ROOT, 'tests', 'golden-fixtures', 'scheduler-workflow-golden-results.json');

interface OpEntry {
  op: string;
  expectKey: string;
  params: Record<string, unknown>;
}

interface Scenario {
  id: string;
  name: string;
  snapshot: Record<string, unknown>;
  seed: {
    plans: Array<Record<string, unknown>>;
    assignments: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
  };
  ops: OpEntry[];
  expect: Record<string, unknown>;
}

const data = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf-8')) as {
  schemaVersion: string;
  scenarios: Scenario[];
};

async function runScenario(scenario: Scenario): Promise<{ scenarioId: string; ops: Array<{ op: string; outcome: unknown }> }> {
  // 场景 JSON 中时间字段为字符串；fake-db 行按 Date 处理（与 persistPlan 落库一致）。
  const seedAssignments = scenario.seed.assignments.map((a) => ({
    ...a,
    plannedStart: a.plannedStart ? new Date(String(a.plannedStart)) : null,
    plannedEnd: a.plannedEnd ? new Date(String(a.plannedEnd)) : null,
  }));
  const { db, state } = makeFakeDb({
    ...scenario.seed,
    assignments: seedAssignments,
  });
  // R2-SSV-13（2026-08-17）：feedback 状态推进按受派者/可信角色授权——
  // golden 工作流以调度席（dispatcher）视角驱动 E2E（受派代录合法路径）。
  const ctx = { ...testOrgContext(), role: 'dispatcher' };
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const worldState = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
    // replan 用真实求解器：buildSnapshot 返回场景快照（含 snapshotVersion 与资源）。
    buildSnapshot: jest.fn().mockResolvedValue(scenario.snapshot),
    getCurrentWorldState: jest.fn().mockResolvedValue({
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
    }),
  };
  const reservationServiceMock = {
    reserve: jest.fn().mockResolvedValue([
      { reservationId: 'RSV-DISPATCH', resourceType: 'person', resourceId: 'p1', startMs: 0, endMs: 1000 },
    ]),
    assertStationCapacityAvailable: jest.fn().mockResolvedValue(undefined),
  };
  const outboxService = {
    enqueue: jest.fn().mockResolvedValue({
      id: 'evt-outbox',
      eventType: 'assignment.dispatched',
      entityId: 'ASG-1',
      payload: {},
      status: 'pending',
      sequence: 1,
      createdAt: new Date().toISOString(),
    }),
  };
  const taskService = { transitionTaskState: jest.fn().mockResolvedValue(undefined) };

  const dispatchCoordinator = new DispatchCoordinatorService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    worldState as unknown as WorldStateSnapshotService,
    reservationServiceMock as unknown as ResourceReservationService,
    outboxService as unknown as OutboxService,
    auditService as unknown as AuditService,
    taskService as unknown as TaskService,
    { recordBaseline: jest.fn().mockResolvedValue(undefined) } as never,
    { getConfig: jest.fn().mockResolvedValue({ defaultTaskDurationMs: 1_800_000 }) } as never,
    {
      estimate: jest.fn().mockResolvedValue({
        routeId: 'R', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
        feasible: true, source: 'route_graph', riskCost: 0, congestionCost: 0,
        graphVersion: null, calculatedAt: new Date().toISOString(),
        fallbackReason: null, dataQuality: 'FRESH',
      }),
    } as never,
  );

  // NO-07c：真实求解器（replan → solve → persistPlan → supersede 全真实）。
  const { solver: realSolver } = makeSolver();
  const schedulingPolicyMock = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getPolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
    getConfigByVersion: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const planService = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    realSolver as unknown as SolverService,
    worldState as unknown as WorldStateSnapshotService,
    dispatchCoordinator,
    schedulingPolicyMock as never,
    { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn() } as never,
    { loadForPlan: jest.fn().mockImplementation(async (_p: string, req: unknown[]) => req), hashConstraints: jest.fn() } as never,
    outboxService as unknown as OutboxService,
    { handleTrigger: jest.fn() } as never,
  );

  // 真实预约服务（独立于 dispatch 的 mock 预占路径，验证重叠冲突不变量）。
  const realReservationService = new ResourceReservationService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
  );

  const outcomes: Array<{ op: string; outcome: unknown }> = [];
  for (const entry of scenario.ops) {
    const params = entry.params;
    if (entry.op === 'approve') {
      const { version, snapshotVersion, staleSnapshot } = params as {
        version: number; snapshotVersion: string; staleSnapshot: boolean;
      };
      if (staleSnapshot) {
        worldState.assertFreshForApprove.mockRejectedValueOnce(new Error('PLAN_STALE'));
      }
      try {
        // B5 审批独立性：审批人换用 u2（生成人 u1 不可自批；golden 结果与
        // 审批人身份无关——outcomes 只记录 status/outbox 等，不记录 userId）。
        const approverCtx = { ...ctx, userId: 'u2' };
        await planService.approvePlan(String(params.planId ?? 'PLAN-1'), { version, snapshotVersion }, approverCtx);
        outcomes.push({
          op: 'approve',
          outcome: {
            ok: true,
            planStatus: state.plans.get(String(params.planId ?? 'PLAN-1'))?.status ?? null,
            // 仅统计目标方案的分配行（fake-db 的 select 忽略 where，需按 planId 过滤）。
            assignmentStatuses: state.assignments
              .filter((a) => a.planId === String(params.planId ?? 'PLAN-1'))
              .map((a) => a.status),
          },
        });
      } catch (err) {
        const reason =
          err instanceof ConflictException
            ? (err as { message?: string }).message?.replace(/:.*$/, '').trim()
            : String((err as Error).message);
        outcomes.push({ op: 'approve', outcome: { ok: false, reason } });
      }
    } else if (entry.op === 'reserve') {
      try {
        const results = await realReservationService.reserve(
          String(params.planId),
          String(params.assignmentId),
          String(params.taskId),
          [
            {
              resourceType: String(params.resourceType) as import('../resource-reservation.service').ReservationInput['resourceType'],
              resourceId: String(params.resourceId),
              startMs: Number(params.startMs),
              endMs: Number(params.endMs),
            },
          ],
          ctx,
        );
        outcomes.push({
          op: 'reserve',
          outcome: { ok: true, reservationIdPrefix: results[0]?.reservationId.slice(0, 4) ?? null },
        });
      } catch (err) {
        const reason =
          err instanceof ConflictException
            ? (err as { message?: string }).message?.replace(/:.*$/, '').trim()
            : String((err as Error).message);
        outcomes.push({ op: 'reserve', outcome: { ok: false, reason } });
      }
    } else if (entry.op === 'feedback') {
      try {
        const feedbackService = new SchedulingFeedbackService(
          db,
          requestDatabaseContext as unknown as RequestDatabaseContext,
        );
        await feedbackService.recordActuals(
          {
            planId: String(params.planId),
            assignmentId: String(params.assignmentId),
            taskId: String(params.taskId),
            actualStart: String(params.actualStart),
            actualEnd: String(params.actualEnd),
            actualResource: params.actualResource as never,
          },
          ctx,
        );
        outcomes.push({ op: 'feedback', outcome: { ok: true } });
      } catch (err) {
        outcomes.push({ op: 'feedback', outcome: { ok: false, reason: String((err as Error).message) } });
      }
    } else if (entry.op === 'replan') {
      try {
        const newPlan = await planService.replan(
          String(params.planId),
          {
            lockedConstraints: (params.lockedConstraints as never[]) ?? [],
            reason: String(params.reason ?? ''),
          },
          ctx,
        );
        const oldRow = state.plans.get(String(params.planId));
        outcomes.push({
          op: 'replan',
          outcome: {
            ok: true,
            newPlanId: newPlan.planId,
            newVersion: newPlan.version,
            oldPlanStatus: oldRow?.status ?? null,
            supersededBy: oldRow?.supersededBy ?? null,
            newAssignments: newPlan.assignments.map((a) => a.taskId).sort(),
          },
        });
        // fake-db 的 select 忽略 where 谓词、恒返回 plans Map 首行；replan 已把旧行
        // 标记 superseded 并落新行。为让后续 approve 读到目标行，此处移除旧行
        // （supersede 结果已在上方 outcome 中如实记录，不改变任何服务逻辑）。
        state.plans.delete(String(params.planId));
      } catch (err) {
        outcomes.push({ op: 'replan', outcome: { ok: false, reason: String((err as Error).message) } });
      }
    } else if (entry.op === 'dispatch') {
      try {
        await planService.dispatchPlan(String(params.planId), ctx);
        outcomes.push({
          op: 'dispatch',
          outcome: {
            ok: true,
            planStatus: state.plans.get(String(params.planId))?.status ?? null,
            assignmentStatuses: state.assignments
              .filter((a) => a.planId === String(params.planId))
              .map((a) => a.status),
            outboxEvents: outboxService.enqueue.mock.calls.map((c) => String(c[0])),
          },
        });
      } catch (err) {
        outcomes.push({ op: 'dispatch', outcome: { ok: false, reason: String((err as Error).message) } });
      }
    } else {
      throw new Error(`unhandled op: ${entry.op}`);
    }
  }
  return { scenarioId: scenario.id, ops: outcomes };
}

describe('golden scheduler workflow scenarios（Phase 7 / NO-07b，跨语言一致）', () => {
  it('场景定义 schemaVersion=1.0.0 且场景齐全', () => {
    expect(data.schemaVersion).toBe('1.0.0');
    expect(data.scenarios.map((s) => s.id)).toEqual([
      'plan_lifecycle_cas_reserve_dispatch',
      'execution_feedback_and_replan',
    ]);
  });

  it('操作序列结果与提交的 golden 结果文件零漂移（确定性重放门禁）', async () => {
    const results = [];
    for (const scenario of data.scenarios) {
      results.push(await runScenario(scenario));
    }
    const committed = fs.existsSync(RESULTS_PATH)
      ? JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'))
      : null;
    if (process.env.UPDATE_GOLDEN_WORKFLOW_RESULTS === '1') {
      fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
      return;
    }
    expect(committed).not.toBeNull();
    expect(results).toEqual(committed);
  });

  for (const scenario of data.scenarios) {
    it(`scenario: ${scenario.id}（${scenario.name}）`, async () => {
      const { ops } = await runScenario(scenario);
      const expectMap = scenario.expect as Record<string, Record<string, unknown>>;
      const opsByKey: Record<string, { op: string; outcome: unknown }> = {};
      ops.forEach((entry, i) => {
        opsByKey[scenario.ops[i].expectKey] = entry;
      });
      for (const [key, entry] of Object.entries(opsByKey)) {
        const expectedOutcome = expectMap[key];
        if (!expectedOutcome) continue;
        const outcome = entry.outcome as Record<string, unknown>;
        if ('outboxEvents' in expectedOutcome) {
          expect(outcome.outboxEvents as string[]).toEqual(
            expect.arrayContaining(expectedOutcome.outboxEvents as string[]),
          );
        }
        for (const [field, value] of Object.entries(expectedOutcome)) {
          if (field === 'outboxEvents') continue;
          if (field === 'newAssignments' || field === 'assignmentStatuses') {
            expect(outcome[field] as string[]).toEqual(value as string[]);
          } else {
            expect(outcome[field]).toBe(value);
          }
        }
      }
    });
  }
});
