import { ConflictException } from '@nestjs/common';
import {
  ModelService,
  nextModelStatus,
} from '../../../server/modules/model/model.service';

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

describe('model registry state transitions', () => {
  it('moves candidate through review to shadow and active', () => {
    expect(nextModelStatus('candidate', 'submit_review')).toBe('reviewing');
    expect(nextModelStatus('reviewing', 'approve_review')).toBe('shadow');
    expect(nextModelStatus('shadow', 'activate')).toBe('active');
  });

  it('rejects illegal transitions by returning current status', () => {
    expect(nextModelStatus('candidate', 'activate')).toBe('candidate');
    expect(nextModelStatus('active', 'approve_review')).toBe('active');
  });

  it('returns 409 STATE_CONFLICT when the conditional update affects zero rows', async () => {
    const before = {
      id: '00000000-0000-4000-8000-000000000002',
      status: 'shadow',
      modelId: 'M-1',
    };
    const { db, updateWhere } = createDbMock([before], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ModelService(db, audit as never);

    const error = await service
      .transitionStatus('00000000-0000-4000-8000-000000000002', 'activate', {
        userId: 'user-1',
        primaryOrgId: 'org-1',
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(error.message).toContain('STATE_CONFLICT');
    expect(sqlContains(updateWhere.mock.calls[0][0], 'status', 'shadow')).toBe(
      true,
    );
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('records actor/org/before/after audit after publishing a model', async () => {
    const before = {
      id: '00000000-0000-4000-8000-000000000002',
      status: 'shadow',
      modelId: 'M-1',
    };
    const after = { ...before, status: 'active' };
    const { db } = createDbMock([before], [after]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ModelService(db, audit as never);

    const result = await service.transitionStatus(
      '00000000-0000-4000-8000-000000000002',
      'activate',
      {
        userId: 'user-1',
        primaryOrgId: 'org-1',
      },
    );

    expect(result.status).toBe('active');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'model.activate',
        entityType: 'model',
        entityId: '00000000-0000-4000-8000-000000000002',
        before: { status: 'shadow' },
        after: { status: 'active' },
      }),
    );
  });
});
