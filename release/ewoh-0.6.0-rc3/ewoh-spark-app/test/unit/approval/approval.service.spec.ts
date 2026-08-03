import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ewohEvent, ewohEventChain } from '../../../server/database/schema';
import { aggregateApprovalStatus } from '../../../server/modules/approval/approval.service';
import { ApprovalPersistenceService as ApprovalService } from '../../../server/modules/approval/approval-persistence.service';

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

function sqlText(node: unknown): string {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node !== 'object') {
    return String(node);
  }
  const record = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(record.queryChunks)) {
    return record.queryChunks.map((chunk) => sqlText(chunk)).join('');
  }
  if (record.value !== undefined) {
    return String(record.value);
  }
  return '';
}

interface DbMocks {
  db: never;
  eventWhere: jest.Mock;
  chainWhere: jest.Mock;
  eventInsertValues: jest.Mock;
  chainInsertValues: jest.Mock;
  eventUpdateWhere: jest.Mock;
  chainUpdateWhere: jest.Mock;
}

function createDbMock(
  overrides: {
    eventRows?: unknown[];
    chainRows?: unknown[];
    eventUpdateRows?: unknown[];
    chainUpdateRows?: unknown[];
  } = {},
): DbMocks {
  const eventRows = overrides.eventRows ?? [];
  const chainRows = overrides.chainRows ?? [];
  const eventUpdateRows = overrides.eventUpdateRows ?? [];
  const chainUpdateRows = overrides.chainUpdateRows ?? [];

  const eventWhere = jest.fn().mockResolvedValue(eventRows);
  const chainWhere = jest
    .fn()
    .mockReturnValue({ orderBy: jest.fn().mockResolvedValue(chainRows) });
  const eventInsertValues = jest.fn().mockResolvedValue(undefined);
  const chainInsertValues = jest.fn().mockResolvedValue(undefined);
  const eventUpdateReturning = jest.fn().mockResolvedValue(eventUpdateRows);
  const chainUpdateReturning = jest.fn().mockResolvedValue(chainUpdateRows);
  const eventUpdateWhere = jest.fn(() => ({
    returning: eventUpdateReturning,
  }));
  const chainUpdateWhere = jest.fn(() => ({
    returning: chainUpdateReturning,
  }));

  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (table === ewohEvent) {
          return { where: eventWhere };
        }
        if (table === ewohEventChain) {
          return { where: chainWhere };
        }
        throw new Error(`unexpected select table ${String(table)}`);
      }),
    })),
    insert: jest.fn((table: unknown) => {
      if (table === ewohEvent) {
        return { values: eventInsertValues };
      }
      if (table === ewohEventChain) {
        return { values: chainInsertValues };
      }
      throw new Error(`unexpected insert table ${String(table)}`);
    }),
    update: jest.fn((table: unknown) => {
      if (table === ewohEvent) {
        return {
          set: jest.fn(() => ({ where: eventUpdateWhere })),
        };
      }
      if (table === ewohEventChain) {
        return {
          set: jest.fn(() => ({ where: chainUpdateWhere })),
        };
      }
      throw new Error(`unexpected update table ${String(table)}`);
    }),
  } as never;

  return {
    db,
    eventWhere,
    chainWhere,
    eventInsertValues,
    chainInsertValues,
    eventUpdateWhere,
    chainUpdateWhere,
  };
}

function createAuditMock() {
  return { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
}

const now = new Date('2026-08-03T00:00:00.000Z');
const instanceId = 'instance-1';
const eventRow = {
  id: '00000000-0000-4000-8000-000000000001',
  eventId: instanceId,
  eventType: 'approval_instance',
  title: 'Approval for task T-1',
  status: 'pending',
  createdAt: now,
  evidenceJson: {
    entityType: 'task',
    entityId: 'T-1',
    createdAt: now.toISOString(),
  },
};

function chainRow(stepId: string, role: string, status: string) {
  return {
    id: `00000000-0000-4000-8000-0000000000${stepId.length}`,
    eventId: stepId,
    parentEventId: instanceId,
    causalType: 'approval_step',
    description: JSON.stringify({
      role,
      status,
      reason: null,
      delegateTo: null,
    }),
    createdAt: now,
  };
}

describe('approval aggregation', () => {
  it('approves only when all steps are approved or skipped', () => {
    expect(
      aggregateApprovalStatus([
        { id: 's1', role: 'lead', status: 'approved' },
        { id: 's2', role: 'safety', status: 'skipped' },
      ]),
    ).toBe('approved');
    expect(
      aggregateApprovalStatus([
        { id: 's1', role: 'lead', status: 'approved' },
        { id: 's2', role: 'safety', status: 'pending' },
      ]),
    ).toBe('pending');
  });

  it('rejects on any rejection and expires on timeout', () => {
    expect(
      aggregateApprovalStatus([
        { id: 's1', role: 'lead', status: 'approved' },
        { id: 's2', role: 'safety', status: 'rejected' },
      ]),
    ).toBe('rejected');
    expect(
      aggregateApprovalStatus([{ id: 's1', role: 'lead', status: 'expired' }]),
    ).toBe('expired');
  });
});

describe('ApprovalService persistence', () => {
  it('creates an instance by writing ewoh_event and ewoh_event_chain rows', async () => {
    const { db, eventInsertValues, chainInsertValues } = createDbMock();
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const result = await service.createApproval({
      entityType: 'task',
      entityId: 'T-1',
      roles: ['lead', 'safety'],
    });

    expect(result.id).toBeTruthy();
    expect(result.entityType).toBe('task');
    expect(result.entityId).toBe('T-1');
    expect(result.status).toBe('pending');
    expect(result.steps).toHaveLength(2);
    expect(result.createdAt).toBeTruthy();

    expect(eventInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: result.id,
        eventType: 'approval_instance',
        status: 'pending',
        title: 'Approval for task T-1',
        sourceType: 'approval',
        evidenceJson: {
          entityType: 'task',
          entityId: 'T-1',
          createdAt: result.createdAt,
        },
      }),
    );
    expect(chainInsertValues).toHaveBeenCalledTimes(1);
    const stepRows = chainInsertValues.mock.calls[0][0] as Array<{
      eventId: string;
      parentEventId: string;
      causalType: string;
      description: string;
    }>;
    expect(stepRows).toHaveLength(2);
    expect(stepRows[0]).toMatchObject({
      parentEventId: result.id,
      causalType: 'approval_step',
    });
    expect(JSON.parse(stepRows[0].description)).toEqual({
      role: 'lead',
      status: 'pending',
      reason: null,
      delegateTo: null,
    });
  });

  it('rejects creation without entity or roles', async () => {
    const { db, eventInsertValues } = createDbMock();
    const service = new ApprovalService(db, createAuditMock() as never);

    const error = await service
      .createApproval({ entityType: '', entityId: 'T-1', roles: [] })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(eventInsertValues).not.toHaveBeenCalled();
  });

  it('restores an instance from event and chain rows', async () => {
    const { db, eventWhere, chainWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending'), chainRow('step-2', 'safety', 'approved')],
    });
    const service = new ApprovalService(db, createAuditMock() as never);

    const result = await service.getApproval(instanceId);

    expect(result).toEqual({
      id: instanceId,
      entityType: 'task',
      entityId: 'T-1',
      status: 'pending',
      steps: [
        { id: 'step-1', role: 'lead', status: 'pending' },
        { id: 'step-2', role: 'safety', status: 'approved' },
      ],
      createdAt: now.toISOString(),
    });
    expect(sqlContains(eventWhere.mock.calls[0][0], 'event_id', instanceId)).toBe(
      true,
    );
    expect(
      sqlContains(eventWhere.mock.calls[0][0], 'event_type', 'approval_instance'),
    ).toBe(true);
    expect(
      sqlContains(chainWhere.mock.calls[0][0], 'parent_event_id', instanceId),
    ).toBe(true);
    expect(
      sqlContains(chainWhere.mock.calls[0][0], 'causal_type', 'approval_step'),
    ).toBe(true);
  });

  it('returns 404 when the approval event does not exist', async () => {
    const { db } = createDbMock({ eventRows: [] });
    const service = new ApprovalService(db, createAuditMock() as never);

    const error = await service.getApproval('missing').catch((caught) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('conditionally updates step and instance and writes audit for a step action', async () => {
    const { db, chainUpdateWhere, eventUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
      chainUpdateRows: [{}],
      eventUpdateRows: [{}],
    });
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const result = await service.stepAction(
      instanceId,
      'step-1',
      'approve',
      'ok',
      undefined,
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.status).toBe('approved');
    expect(result.steps[0]).toMatchObject({ status: 'approved', reason: 'ok' });
    expect(sqlText(chainUpdateWhere.mock.calls[0][0])).toContain(
      "jsonb->>'status'",
    );
    expect(sqlText(chainUpdateWhere.mock.calls[0][0])).toContain('pending');
    expect(
      sqlContains(chainUpdateWhere.mock.calls[0][0], 'event_id', 'step-1'),
    ).toBe(true);
    expect(
      sqlContains(eventUpdateWhere.mock.calls[0][0], 'event_id', instanceId),
    ).toBe(true);
    expect(
      sqlContains(eventUpdateWhere.mock.calls[0][0], 'status', 'pending'),
    ).toBe(true);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'approval.approve',
        entityType: 'approval',
        entityId: instanceId,
        before: {
          instanceStatus: 'pending',
          stepStatus: 'pending',
          reason: null,
          delegateTo: null,
        },
        after: {
          instanceStatus: 'approved',
          stepStatus: 'approved',
          reason: 'ok',
          delegateTo: null,
        },
      }),
    );
  });

  it('returns 409 when the step conditional update affects zero rows', async () => {
    const { db, chainUpdateWhere, eventUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
      chainUpdateRows: [],
      eventUpdateRows: [{}],
    });
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const error = await service
      .stepAction(instanceId, 'step-1', 'approve')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(sqlText(chainUpdateWhere.mock.calls[0][0])).toContain('pending');
    expect(eventUpdateWhere).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('returns 409 when the instance conditional update affects zero rows', async () => {
    const { db, eventUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
      chainUpdateRows: [{}],
      eventUpdateRows: [],
    });
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const error = await service
      .stepAction(instanceId, 'step-1', 'approve')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(eventUpdateWhere).toHaveBeenCalledTimes(1);
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('rejects a step action when the instance is not pending', async () => {
    const { db, chainUpdateWhere } = createDbMock({
      eventRows: [{ ...eventRow, status: 'approved' }],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
    });
    const service = new ApprovalService(db, createAuditMock() as never);

    const error = await service
      .stepAction(instanceId, 'step-1', 'approve')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(chainUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects a step action when the step is not pending', async () => {
    const { db, chainUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'approved')],
    });
    const service = new ApprovalService(db, createAuditMock() as never);

    const error = await service
      .stepAction(instanceId, 'step-1', 'approve')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(chainUpdateWhere).not.toHaveBeenCalled();
  });

  it('returns 404 when the step is missing', async () => {
    const { db } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
    });
    const service = new ApprovalService(db, createAuditMock() as never);

    const error = await service
      .stepAction(instanceId, 'missing', 'approve')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('bypasses by conditionally skipping pending steps and auditing', async () => {
    const { db, chainUpdateWhere, eventUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [
        chainRow('step-1', 'lead', 'pending'),
        chainRow('step-2', 'safety', 'approved'),
      ],
      chainUpdateRows: [{}],
      eventUpdateRows: [{}],
    });
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const result = await service.bypass(instanceId, 'urgent', {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });

    expect(result.status).toBe('bypassed');
    expect(result.steps[0]).toMatchObject({ status: 'skipped', reason: 'urgent' });
    expect(result.steps[1]).toMatchObject({ status: 'approved' });
    expect(chainUpdateWhere).toHaveBeenCalledTimes(1);
    expect(sqlText(chainUpdateWhere.mock.calls[0][0])).toContain('pending');
    expect(eventUpdateWhere).toHaveBeenCalledTimes(1);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval.bypass',
        entityType: 'approval',
        entityId: instanceId,
        before: { instanceStatus: 'pending', steps: expect.any(Array) },
        after: { instanceStatus: 'bypassed', steps: expect.any(Array) },
      }),
    );
  });

  it('returns 409 when bypass loses a step race', async () => {
    const { db, eventUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
      chainUpdateRows: [],
      eventUpdateRows: [{}],
    });
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const error = await service.bypass(instanceId, 'urgent').catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(eventUpdateWhere).not.toHaveBeenCalled();
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('cancels an instance with a conditional update and audit', async () => {
    const { db, eventUpdateWhere } = createDbMock({
      eventRows: [eventRow],
      chainRows: [chainRow('step-1', 'lead', 'pending')],
      eventUpdateRows: [{}],
    });
    const audit = createAuditMock();
    const service = new ApprovalService(db, audit as never);

    const result = await service.cancel(instanceId, {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });

    expect(result.status).toBe('cancelled');
    expect(eventUpdateWhere).toHaveBeenCalledTimes(1);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval.cancel',
        entityType: 'approval',
        entityId: instanceId,
        before: { instanceStatus: 'pending' },
        after: { instanceStatus: 'cancelled' },
      }),
    );
  });

  it('rejects cancel on terminal instances', async () => {
    const { db, eventUpdateWhere } = createDbMock({
      eventRows: [{ ...eventRow, status: 'approved' }],
    });
    const service = new ApprovalService(db, createAuditMock() as never);

    const error = await service.cancel(instanceId).catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(eventUpdateWhere).not.toHaveBeenCalled();
  });
});
