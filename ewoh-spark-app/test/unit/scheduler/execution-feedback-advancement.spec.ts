/* execution-feedback-advancement.spec.ts — 执行反馈完成腿（NO-13a / ADR-050）。
 *
 * recordActuals 在回填真实执行事实后推进 assignment/task 状态：
 *  - assignment：dispatched→executing（start）/ {dispatched,executing}→completed（end）+ 事件；
 *  - task：taskActionPath 契约最短合法链（task.yaml 锁步）逐动作 transitionTaskState；
 *  - 边界显式：exception 不隐式 resolve、pending_dispatch 不收 start、终态 no-op、
 *    乱序 skip+log；幂等（重复回填推进 no-op）。
 */
import { SchedulingFeedbackService } from '../../../server/modules/scheduler/scheduling-feedback.service';
import { TaskService } from '../../../server/modules/task/task.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { makeFakeDb, testOrgContext } from '../../../server/modules/scheduler/__tests__/dispatch-test-harness';

const TASK_ID = '9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

function buildService(seed: Parameters<typeof makeFakeDb>[0] = {}) {
  const { db, state } = makeFakeDb(seed);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditLogs: Array<Record<string, unknown>> = [];
  const auditService = {
    appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
      auditLogs.push(entry);
    }),
  };
  const taskService = new TaskService(db as never, auditService as never);
  const svc = new SchedulingFeedbackService(
    db as never,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    undefined,
    taskService,
  );
  return { svc, state, auditLogs };
}

function seedDispatched(taskStatus: string) {
  return {
    assignments: [
      {
        assignmentId: 'ASG-FB-1',
        planId: 'PLAN-FB-1',
        taskId: TASK_ID,
        personId: 'p1',
        deviceId: 'd1',
        stationId: 's1',
        status: 'dispatched',
      },
    ],
    tasks: [{ id: TASK_ID, status: taskStatus }],
  };
}

describe('执行反馈完成腿（ADR-050）：feedback → assignment → task 状态推进', () => {
  it('actualStart：assignment dispatched→executing + task dispatched→receive→start→executing（事件+审计）', async () => {
    const { svc, state, auditLogs } = buildService(seedDispatched('dispatched'));
    const summary = await svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualStart: '2026-08-16T08:05:00Z' },
      testOrgContext(),
    );
    expect(summary.advancedAssignments).toBe(1);
    expect(summary.advancedTaskSteps).toBe(2);
    expect(summary.skips).toEqual([]);
    expect(state.assignments[0].status).toBe('executing');
    expect(state.tasks.get(TASK_ID)?.status).toBe('executing');
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toEqual(expect.objectContaining({
      assignmentId: 'ASG-FB-1',
      fromStatus: 'dispatched',
      toStatus: 'executing',
      reason: 'execution feedback actualStart',
    }));
    // task 两步推进均有审计（receive + start）。
    expect(auditLogs.map((l) => l.action)).toEqual(['task.receive', 'task.start']);
  });

  it('actualEnd：assignment executing→completed + task executing→complete（事件+审计）', async () => {
    const { svc, state, auditLogs } = buildService({
      assignments: [
        {
          assignmentId: 'ASG-FB-1',
          planId: 'PLAN-FB-1',
          taskId: TASK_ID,
          status: 'executing',
        },
      ],
      tasks: [{ id: TASK_ID, status: 'executing' }],
    });
    const summary = await svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualEnd: '2026-08-16T08:30:00Z' },
      testOrgContext(),
    );
    expect(summary.advancedAssignments).toBe(1);
    expect(summary.advancedTaskSteps).toBe(1);
    expect(state.assignments[0].status).toBe('completed');
    expect(state.tasks.get(TASK_ID)?.status).toBe('completed');
    expect(state.events[0]).toEqual(expect.objectContaining({
      fromStatus: 'executing',
      toStatus: 'completed',
      reason: 'execution feedback actualEnd',
    }));
    expect(auditLogs.map((l) => l.action)).toEqual(['task.complete']);
  });

  it('actualEnd 无 start 观测：assignment dispatched→completed（单事件，不伪造中间状态）；task dispatched 乱序 skip', async () => {
    const { svc, state } = buildService(seedDispatched('dispatched'));
    const summary = await svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualEnd: '2026-08-16T08:30:00Z' },
      testOrgContext(),
    );
    expect(summary.advancedAssignments).toBe(1);
    expect(summary.advancedTaskSteps).toBe(0);
    expect(state.assignments[0].status).toBe('completed');
    expect(state.events).toHaveLength(1);
    expect(state.events[0].fromStatus).toBe('dispatched');
    expect(state.events[0].toStatus).toBe('completed');
    // task 处于 dispatched（end 源集外）→ 显式 skip，绝不猜测推进。
    expect(summary.skips).toContain('task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11:out_of_order_from_dispatched');
    expect(state.tasks.get(TASK_ID)?.status).toBe('dispatched');
  });

  it('幂等：重复 start/end 推进 no-op（已一致 skip，无新事件）', async () => {
    const { svc, state } = buildService(seedDispatched('dispatched'));
    await svc.recordActuals({ assignmentId: 'ASG-FB-1', actualStart: '2026-08-16T08:05:00Z' }, testOrgContext());
    const second = await svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualStart: '2026-08-16T08:06:00Z' },
      testOrgContext(),
    );
    expect(second.advancedAssignments).toBe(0);
    expect(second.advancedTaskSteps).toBe(0);
    expect(second.skips).toEqual([
      'assignment:ASG-FB-1:start_already_executing',
      'task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11:start_already_executing',
    ]);
    expect(state.events).toHaveLength(1);
    expect(state.assignments[0].status).toBe('executing');
  });

  it('乱序反馈（task 未派工）与异常不隐式 resolve（显式边界）', async () => {
    const { svc, state } = buildService(seedDispatched('pending_dispatch'));
    const outOfOrder = await svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualStart: '2026-08-16T08:05:00Z' },
      testOrgContext(),
    );
    // assignment（dispatched）正常推进；task pending_dispatch → 显式 skip。
    expect(state.assignments[0].status).toBe('executing');
    expect(state.tasks.get(TASK_ID)?.status).toBe('pending_dispatch');
    expect(outOfOrder.skips).toContain('task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11:out_of_order_from_pending_dispatch');

    const withTask = buildService({
      assignments: [{ assignmentId: 'ASG-FB-1', planId: 'PLAN-FB-1', taskId: TASK_ID, status: 'executing' }],
      tasks: [{ id: TASK_ID, status: 'exception' }],
    });
    const exceptionCase = await withTask.svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualEnd: '2026-08-16T08:30:00Z' },
      testOrgContext(),
    );
    expect(exceptionCase.advancedAssignments).toBe(1);
    expect(exceptionCase.skips).toContain('task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11:out_of_order_from_exception');
    expect(withTask.state.tasks.get(TASK_ID)?.status).toBe('exception');
  });

  it('无执行事实（仅 actualTravel）→ 不推进（summary 全零，无事件）', async () => {
    const { svc, state } = buildService(seedDispatched('dispatched'));
    const summary = await svc.recordActuals(
      { assignmentId: 'ASG-FB-1', actualTravel: 120 },
      testOrgContext(),
    );
    expect(summary).toEqual({ advancedAssignments: 0, advancedTaskSteps: 0, skips: [] });
    expect(state.events).toHaveLength(0);
    expect(state.assignments[0].status).toBe('dispatched');
  });
});
