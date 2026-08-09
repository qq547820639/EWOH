import { ExecutionService } from '../execution.service';

describe('ExecutionService（P4-EXEC：正式执行领域）', () => {
  const outbox = { enqueue: jest.fn().mockResolvedValue({}) } as never;
  const metrics = { recordExecutionTransition: jest.fn() } as never;

  beforeEach(() => {
    (outbox as unknown as { enqueue: jest.Mock }).enqueue.mockClear();
  });

  const makeRow = (over: Record<string, unknown> = {}) => ({
    id: 'id-1',
    executionId: 'EXEC-1',
    orgId: null,
    runId: 'RUN-1',
    planId: 'PLAN-1',
    assignmentId: 'ASG-1',
    taskId: 'T-1',
    personId: 'p1',
    deviceId: null,
    stationId: 'S1',
    plannedStartAt: new Date('2026-01-01T00:00:00.000Z'),
    plannedEndAt: new Date('2026-01-01T01:00:00.000Z'),
    actualStartAt: null,
    actualEndAt: null,
    plannedTravelMs: 60000,
    actualTravelMs: null,
    plannedDistanceM: 100,
    actualDistanceM: null,
    plannedWaitingMs: 0,
    actualWaitingMs: null,
    status: 'PLANNED',
    deviationType: null,
    deviationReason: null,
    snapshotVersion: 'WS-1',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    source: 'dispatch',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  it('createFromPlan：由 Plan Assignment 创建 PLANNED 执行记录（含 planned 行程事实）', async () => {
    const inserted = makeRow({ assignmentId: 'ASG-NEW', executionId: 'EXEC-NEW' });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })) })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([inserted])) })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    const created = await svc.createFromPlan(
      { planId: 'PLAN-1', runId: 'RUN-1', snapshotVersion: 'WS-1', policyVersion: 1, solverVersion: 'heuristic-v2' },
      [{ assignmentId: 'ASG-NEW', taskId: 'T-1', personId: 'p1', deviceId: null, stationId: 'S1', plannedStart: '2026-01-01T00:00:00Z', plannedEnd: '2026-01-01T01:00:00Z', etaSeconds: 60, distanceMeters: 100 }],
      null,
    );
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('PLANNED');
    expect(created[0].plannedTravelMs).toBe(60000);
    expect(created[0].plannedDistanceM).toBe(100);
  });

  it('update：STARTED 记录 actualStart；晚 10 分钟 → 派生 START_DELAY 并发布 deviation 事件', async () => {
    const base = makeRow();
    const updated = makeRow({
      status: 'STARTED',
      actualStartAt: new Date('2026-01-01T00:10:00.000Z'),
      deviationType: 'START_DELAY',
      deviationReason: 'start delayed 600s',
    });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([base])) })) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([updated])) })),
        })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    const result = await svc.update('ASG-1', { status: 'STARTED', actualStartAt: '2026-01-01T00:10:00.000Z' }, null);
    expect(result.status).toBe('STARTED');
    const calls = (outbox as unknown as { enqueue: jest.Mock }).enqueue.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => c[0])).toContain('execution.deviation');
  });

  it('update：终态幂等——COMPLETED 后拒绝迁移', async () => {
    const terminal = makeRow({ status: 'COMPLETED', actualEndAt: new Date('2026-01-01T01:05:00.000Z') });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([terminal])) })) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([terminal])) })) })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    await expect(svc.update('ASG-1', { status: 'STARTED' }, null)).rejects.toThrow(/already terminal/);
  });

  it('update：DEVICE_FAILURE → 事件 payload triggerReplan=true（可重排偏差）', async () => {
    const base = makeRow({ status: 'STARTED', actualStartAt: new Date('2026-01-01T00:00:00.000Z') });
    const updated = makeRow({ status: 'FAILED', deviationType: 'DEVICE_FAILURE', deviationReason: 'device offline' });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([base])) })) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([updated])) })) })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    await svc.update('ASG-1', { status: 'FAILED', deviationType: 'DEVICE_FAILURE', deviationReason: 'device offline' }, null);
    const calls = (outbox as unknown as { enqueue: jest.Mock }).enqueue.mock.calls;
    const deviationEvent = calls.find((c) => c[0] === 'execution.deviation');
    expect(deviationEvent).toBeTruthy();
    expect((deviationEvent[2] as { triggerReplan: boolean }).triggerReplan).toBe(true);
  });
});
