import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';

describe('SchedulingFeedbackService（Task 7 调度反馈，planned vs actual）', () => {
  const planId = 'PLAN-FB-1';
  const assignmentId = 'ASG-FB-1';
  const taskId = 'TASK-FB-1';

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

  function seedPlan() {
    return {
      plans: [
        {
          planId,
          planName: '计划-反馈',
          strategy: 'scheduler-v2',
          status: 'dispatched',
          triggerEntityId: 'RUN-1',
          orgId: 'org1',
          metricsJson: { solveDurationMs: 250, solverStatus: 'OPTIMAL' },
        },
      ],
      assignments: [
        {
          assignmentId,
          planId,
          taskId,
          personId: 'p1',
          deviceId: 'd1',
          stationId: 's1',
          plannedStart: new Date('2026-08-08T08:00:00.000Z'),
          plannedEnd: new Date('2026-08-08T08:30:00.000Z'),
          distanceMeters: 120,
        },
      ],
    };
  }

  it('dispatch 记录 planned 基线后，回填 actual 并派生 KPI', async () => {
    const { svc, state } = buildService(seedPlan());
    const ctx = testOrgContext();

    // 1) dispatch 时记录 baseline（观测型，含 solver runtime / replan / conflict）。
    const written = await svc.recordBaseline(planId, { runId: 'RUN-1' }, ctx);
    expect(written).toBe(1);
    expect(state.feedback).toHaveLength(1);

    const row = state.feedback[0];
    expect(row.feedbackId).toMatch(/^FB-/);
    expect(row.planId).toBe(planId);
    expect(row.assignmentId).toBe(assignmentId);
    expect(row.taskId).toBe(taskId);
    expect(row.plannedStart).toEqual(new Date('2026-08-08T08:00:00.000Z'));
    expect(row.plannedEnd).toEqual(new Date('2026-08-08T08:30:00.000Z'));
    expect(row.plannedTravel).toBe(120);
    expect(row.originalResourceJson).toEqual({
      personId: 'p1',
      deviceId: 'd1',
      stationId: 's1',
    });
    // 从 plan.metricsJson 派生 solver runtime / fallback。
    expect(row.solverRuntime).toBe(250);
    expect(row.solverFallback).toBe(false);
    expect(row.replanCount).toBe(0);
    expect(row.conflictCount).toBe(0);
    expect(row.overrideCount).toBe(0);
    expect(row.accepted).toBeNull();

    // 2) 任务实际执行后回填 actual。
    await svc.recordActuals(
      {
        planId,
        assignmentId,
        actualStart: '2026-08-08T08:02:00.000Z',
        actualEnd: '2026-08-08T08:35:00.000Z',
        actualTravel: 150,
        actualResource: { personId: 'p1', deviceId: 'd1', stationId: 's2' },
      },
      ctx,
    );
    const updatedRow = state.feedback[0];
    expect(updatedRow.actualStart).toEqual(new Date('2026-08-08T08:02:00.000Z'));
    expect(updatedRow.actualEnd).toEqual(new Date('2026-08-08T08:35:00.000Z'));
    expect(updatedRow.actualTravel).toBe(150);
    expect(updatedRow.actualResourceJson).toEqual({ personId: 'p1', deviceId: 'd1', stationId: 's2' });

    // 3) 审批结果反馈。
    await svc.recordAcceptance(planId, true, ctx);
    expect(state.feedback[0].accepted).toBe(true);

    // 4) 派生 KPI。
    const kpis = await svc.deriveKpis();
    expect(kpis.totalFeedback).toBe(1);
    expect(kpis.accepted).toBe(1);
    expect(kpis.rejected).toBe(0);
    expect(kpis.pendingAcceptance).toBe(0);
    expect(kpis.acceptanceRate).toBe(1);
    expect(kpis.overrideRate).toBe(0);
    expect(kpis.fallbackRate).toBe(0);
    expect(kpis.solverRuntimeMs).toBe(250);
    expect(kpis.replanCount).toBe(0);
    expect(kpis.conflictCount).toBe(0);

    // 5) 离线评估视图。
    const rows = await svc.listForPlan(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0].plannedStart).toBe('2026-08-08T08:00:00.000Z');
    expect(rows[0].actualStart).toBe('2026-08-08T08:02:00.000Z');
    expect(rows[0].actualEnd).toBe('2026-08-08T08:35:00.000Z');
    expect(rows[0].actualTravel).toBe(150);
    expect(rows[0].originalResource?.stationId).toBe('s1');
    expect(rows[0].actualResource?.stationId).toBe('s2');
  });

  it('override / fallback 反馈被计入 KPI 比率', async () => {
    const { svc, state } = buildService(seedPlan());
    const ctx = testOrgContext();

    await svc.recordBaseline(planId, { overrideCount: 2, solverFallback: true }, ctx);
    expect(state.feedback).toHaveLength(1);

    const kpis = await svc.deriveKpis();
    expect(kpis.overrideRate).toBe(1);
    expect(kpis.fallbackRate).toBe(1);
    expect(kpis.solverRuntimeMs).toBe(250);
  });

  it('无 assignment 时仍写一行 plan 级反馈；replan 计数累加', async () => {
    const { svc, state } = buildService({
      plans: [
        {
          planId,
          planName: '计划-无assign',
          strategy: 'scheduler-v2',
          status: 'dispatched',
          orgId: 'org1',
          metricsJson: { solveDurationMs: 100 },
        },
      ],
    });
    const ctx = testOrgContext();

    await svc.recordBaseline(planId, { replanCount: 3, conflictCount: 2 }, ctx);
    expect(state.feedback).toHaveLength(1);
    const row = state.feedback[0];
    expect(row.assignmentId).toBeNull();
    expect(row.taskId).toBeNull();
    expect(row.originalResourceJson).toBeNull();
    expect(row.replanCount).toBe(3);
    expect(row.conflictCount).toBe(2);

    const rows = await svc.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].assignmentId).toBeNull();
  });

  it('plan 不存在时 recordBaseline 不写任何行', async () => {
    const { svc, state } = buildService();
    const written = await svc.recordBaseline('PLAN-MISSING', {}, testOrgContext());
    expect(written).toBe(0);
    expect(state.feedback).toHaveLength(0);
  });
});