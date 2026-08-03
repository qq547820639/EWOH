import { ConflictException } from '@nestjs/common';
import {
  nextTaskStatus,
  TaskService,
} from '../../../server/modules/task/task.service';

function sqlContains(
  condition: unknown,
  column: string,
  value: string,
): boolean {
  const strings: string[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string') strings.push(node);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(condition);
  return strings.includes(column) && strings.includes(value);
}

function createDbMock(selectRows: unknown[], updateRows: unknown[]) {
  const updateReturning = jest.fn().mockResolvedValue(updateRows);
  const updateWhere = jest.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  return {
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue(selectRows),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
    } as never,
    updateWhere,
  };
}

describe('task state machine', () => {
  it('walks the full happy path', () => {
    let status = 'draft';
    for (const action of [
      'submit',
      'request_approval',
      'approve',
      'dispatch',
      'receive',
      'start',
      'complete',
    ]) {
      const next = nextTaskStatus(status, action);
      expect(next).not.toBeNull();
      status = next!;
    }
    expect(status).toBe('completed');
  });

  it('rejects illegal transitions and supports cancel from non-terminal states', () => {
    expect(nextTaskStatus('draft', 'complete')).toBeNull();
    expect(nextTaskStatus('executing', 'cancel')).toBe('cancelled');
    expect(nextTaskStatus('completed', 'cancel')).toBeNull();
  });

  it('returns 409 STATE_CONFLICT when the conditional update affects zero rows', async () => {
    const before = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'executing',
      title: 'task',
    };
    const { db, updateWhere } = createDbMock([before], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new TaskService(db, audit as never);

    const error = await service
      .transitionTaskState('00000000-0000-4000-8000-000000000001', 'complete', {
        userId: 'user-1',
        primaryOrgId: 'org-1',
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(error.message).toContain('STATE_CONFLICT');
    expect(
      sqlContains(updateWhere.mock.calls[0][0], 'status', 'executing'),
    ).toBe(true);
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('records actor/org/before/after audit after a successful transition', async () => {
    const before = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'executing',
      title: 'task',
    };
    const after = { ...before, status: 'completed' };
    const { db } = createDbMock([before], [after]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new TaskService(db, audit as never);

    const result = await service.transitionTaskState(
      '00000000-0000-4000-8000-000000000001',
      'complete',
      {
        userId: 'user-1',
        primaryOrgId: 'org-1',
      },
    );

    expect(result.status).toBe('completed');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'task.complete',
        entityType: 'production_task',
        entityId: '00000000-0000-4000-8000-000000000001',
        before: { status: 'executing' },
        after: { status: 'completed' },
      }),
    );
  });
});
