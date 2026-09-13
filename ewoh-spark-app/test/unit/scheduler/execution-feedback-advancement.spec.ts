import { ConflictException, ForbiddenException } from '@nestjs/common';
import { makeCanonicalReceiptHarness } from '../../../server/modules/scheduler/__tests__/canonical-receipt-test-harness';

describe('canonical execution receipt state advancement', () => {
  it('actual start advances assignment and task through the real canonical application', async () => {
    const h = makeCanonicalReceiptHarness();
    const result = await h.feedback.recordActuals({ assignmentId: h.assignmentId, actualStart: '2026-08-16T08:05:00Z' }, h.actor);
    expect(result).toMatchObject({ matchedRows: 1, advancedAssignments: 1, advancedTaskSteps: 2 });
    expect(h.state.assignments[0].status).toBe('executing');
    expect(h.state.tasks[0].status).toBe('executing');
    expect(h.state.events).toHaveLength(1);
    expect(h.state.taskAudit.map(x => x.action)).toEqual(['task.receive', 'task.start']);
  });

  it('completion updates execution, feedback, assignment and task atomically', async () => {
    const h = makeCanonicalReceiptHarness({ assignmentStatus: 'executing', taskStatus: 'executing', executionStatus: 'STARTED' });
    const result = await h.feedback.recordActuals({ assignmentId: h.assignmentId, actualStart: '2026-08-16T08:05:00Z', actualEnd: '2026-08-16T08:30:00Z' }, h.actor);
    expect(result).toMatchObject({ matchedRows: 1, advancedAssignments: 1, advancedTaskSteps: 1 });
    expect(h.state.executions[0].status).toBe('COMPLETED');
    expect(h.state.feedback[0]).toMatchObject({ receiptSource: 'unknown', productionTrainingEligible: false });
    expect(h.state.assignments[0].status).toBe('completed');
    expect(h.state.tasks[0].status).toBe('completed');
  });

  it('missing start on completion is rejected and the transaction rolls every write back', async () => {
    const h = makeCanonicalReceiptHarness({ assignmentStatus: 'executing', taskStatus: 'executing', executionStatus: 'STARTED' });
    await expect(h.feedback.recordActuals({ assignmentId: h.assignmentId, actualEnd: '2026-08-16T08:30:00Z' }, h.actor)).rejects.toThrow();
    expect(h.state.assignments[0].status).toBe('executing');
    expect(h.state.executions[0].status).toBe('STARTED');
    expect(h.state.feedback).toHaveLength(0);
  });

  it('exact retry is idempotent and conflicting actuals cannot overwrite facts', async () => {
    const h = makeCanonicalReceiptHarness({ assignmentStatus: 'executing', taskStatus: 'executing', executionStatus: 'STARTED' });
    const input = { assignmentId: h.assignmentId, actualStart: '2026-08-16T08:05:00Z', actualEnd: '2026-08-16T08:30:00Z' };
    await h.feedback.recordActuals(input, h.actor);
    const events = h.state.events.length; const outbox = h.state.outbox.length;
    await h.feedback.recordActuals(input, h.actor);
    expect(h.state.events).toHaveLength(events); expect(h.state.outbox).toHaveLength(outbox);
    await expect(h.feedback.recordActuals({ ...input, actualEnd: '2026-08-16T08:31:00Z' }, h.actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it('assignee authorization is enforced by canonical application', async () => {
    const h = makeCanonicalReceiptHarness({ personId: 'worker-1' });
    await expect(h.feedback.recordActuals({ assignmentId: h.assignmentId, actualStart: '2026-08-16T08:05:00Z' }, { userId: 'intruder', primaryOrgId: 'org1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('simulation/manual HTTP receipt cannot become eligible from real task/device registration', async () => {
    const h = makeCanonicalReceiptHarness({ executionSource: 'simulated' });
    const result = await h.canonical.applyFromActuals({ assignmentId: h.assignmentId, actualStart: '2026-08-16T08:05:00Z', actualEnd: '2026-08-16T08:30:00Z' }, h.actor);
    expect(result!.receipt.source).toBe('simulated');
    expect(result!.receipt.productionTrainingEligible).toBe(false);
  });
});
