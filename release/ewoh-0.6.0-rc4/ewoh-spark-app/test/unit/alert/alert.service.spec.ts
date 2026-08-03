import { ConflictException } from '@nestjs/common';
import {
  AlertService,
  nextAlertStatus,
} from '../../../server/modules/alert/alert.service';

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

describe('alert state machine', () => {
  it('walks acknowledge/process/close and reopen', () => {
    expect(nextAlertStatus('open', 'acknowledge')).toBe('acknowledged');
    expect(nextAlertStatus('acknowledged', 'process')).toBe('processing');
    expect(nextAlertStatus('processing', 'close')).toBe('closed');
    expect(nextAlertStatus('closed', 'reopen')).toBe('reopened');
    expect(nextAlertStatus('reopened', 'process')).toBe('processing');
  });

  it('rejects illegal transitions', () => {
    expect(nextAlertStatus('open', 'close')).toBeNull();
    expect(nextAlertStatus('closed', 'acknowledge')).toBeNull();
  });

  it('returns 409 STATE_CONFLICT when the conditional update affects zero rows', async () => {
    const before = { eventId: 'EVT-1', status: 'processing', title: 'alert' };
    const { db, updateWhere } = createDbMock([before], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AlertService(db, audit as never);

    const error = await service
      .transitionAlert('EVT-1', 'close', {
        userId: 'user-1',
        primaryOrgId: 'org-1',
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(error.message).toContain('STATE_CONFLICT');
    expect(
      sqlContains(updateWhere.mock.calls[0][0], 'status', 'processing'),
    ).toBe(true);
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('records actor/org/before/after audit after closing an alert', async () => {
    const before = { eventId: 'EVT-1', status: 'processing', title: 'alert' };
    const after = { ...before, status: 'closed' };
    const { db } = createDbMock([before], [after]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new AlertService(db, audit as never);

    const result = await service.transitionAlert('EVT-1', 'close', {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });

    expect(result.status).toBe('closed');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'alert.close',
        entityType: 'alert',
        entityId: 'EVT-1',
        before: { status: 'processing' },
        after: { status: 'closed' },
      }),
    );
  });
});
