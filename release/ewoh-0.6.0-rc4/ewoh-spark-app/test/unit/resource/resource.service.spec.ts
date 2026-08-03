import {
  ResourceService,
  availableQuantity,
  canIssue,
} from '../../../server/modules/resource/resource.service';
import { FakeSqlDb } from '../../helpers/fake-sql-db';

describe('resource preorder math', () => {
  const preorders = [
    { id: 'p1', resourceId: 'mat-a', quantity: 5, issuedQty: 2, status: 'pending' as const },
    { id: 'p2', resourceId: 'mat-a', quantity: 3, issuedQty: 0, status: 'pending' as const },
  ];

  it('reserves only the unissued remainder', () => {
    expect(availableQuantity(20, preorders)).toBe(20 - (3 + 3));
  });

  it('rejects issues beyond the preorder or inventory', () => {
    expect(canIssue(preorders[0], 20, 4)).toBe(false);
    expect(canIssue(preorders[0], 20, 3)).toBe(true);
    expect(canIssue(preorders[0], 0, 1)).toBe(false);
  });
});

describe('ResourceService persistence', () => {
  const preorderRow = {
    preorder_id: 'p1',
    resource_id: 'mat-a',
    quantity: 5,
    reserved_qty: 5,
    issued_qty: 0,
    status: 'pending',
  };

  it('persists preorders and rejects oversell', async () => {
    const singleRow = { ...preorderRow, quantity: 1, reserved_qty: 1 };
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([singleRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([singleRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([singleRow]);
    const service = new ResourceService({ execute } as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 1 }]);

    const preorder = await service.createPreorder('mat-a', 1);

    expect(preorder.id).toBe('p1');
    await expect(service.createPreorder('mat-a', 1)).rejects.toThrow(
      'Insufficient available quantity',
    );
    expect(execute).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('ewoh_resource_binding');
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('inventory');
    expect(JSON.stringify(execute.mock.calls[1][0])).toContain('quantity');
    expect(JSON.stringify(execute.mock.calls[3][0])).toContain('ewoh_resource_preorder');
  });

  it('persists issue updates, inventory deduction, and a resource binding', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([preorderRow])
      .mockResolvedValueOnce([preorderRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ quantity: 5 }])
      .mockResolvedValueOnce([{ quantity: 3 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2, reserved_qty: 3 }]);
    const service = new ResourceService({ execute } as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 5 }]);

    const result = await service.issue('p1', 2);

    expect(result.issuedQty).toBe(2);
    expect(service.getInventory('mat-a')).toBe(3);
    expect(JSON.stringify(execute.mock.calls[2][0])).toContain('ewoh_resource_binding');
    expect(JSON.stringify(execute.mock.calls[3][0])).toContain('quantity');
    expect(JSON.stringify(execute.mock.calls[4][0])).toContain('quantity -');
    expect(JSON.stringify(execute.mock.calls[5][0])).toContain('ewoh_resource_preorder');
    expect(JSON.stringify(execute.mock.calls[6][0])).toContain('ewoh_resource_binding');
  });

  it('persists inventory via FakeSqlDb and issues without oversell', async () => {
    const db = new FakeSqlDb();
    const service = new ResourceService({ execute: db.execute.bind(db) } as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 2 }]);

    const preorder = await service.createPreorder('mat-a', 2);
    await service.issue(preorder.id, 2);

    expect(service.getInventory('mat-a')).toBe(0);
    await expect(service.createPreorder('mat-a', 1)).rejects.toThrow(
      'Insufficient available quantity',
    );
  });

  it('returns released quantity to inventory and records a release binding', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2 }])
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ quantity: 6 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2, status: 'released' }]);
    const service = new ResourceService({ execute } as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 3 }]);

    const result = await service.release('p1');

    expect(result.status).toBe('released');
    expect(service.getInventory('mat-a')).toBe(6);
    expect(JSON.stringify(execute.mock.calls[2][0])).toContain('ewoh_resource_binding');
    expect(JSON.stringify(execute.mock.calls[3][0])).toContain('quantity +');
    expect(JSON.stringify(execute.mock.calls[5][0])).toContain('ewoh_resource_binding');
  });

  it('rejects issue when the conditional inventory update affects zero rows', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([preorderRow])
      .mockResolvedValueOnce([preorderRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ quantity: 5 }])
      .mockResolvedValueOnce([]);
    const service = new ResourceService({ execute } as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 5 }]);

    await expect(service.issue('p1', 2)).rejects.toThrow(
      'Insufficient issue quantity',
    );

    expect(service.getInventory('mat-a')).toBe(5);
    expect(JSON.stringify(execute.mock.calls[4][0])).toContain('ewoh_resource_binding');
    expect(JSON.stringify(execute.mock.calls[4][0])).toContain('quantity');
  });

  it('serializes concurrent preorders so inventory is never oversold', async () => {
    let active: Array<Record<string, unknown>> = [];
    const execute = jest.fn(async (statement: unknown) => {
      const sql = JSON.stringify(statement);
      if (sql.includes('select') && sql.includes('ewoh_resource_preorder')) {
        return active.map((row) => ({ ...row }));
      }
      if (sql.includes('insert') && sql.includes('ewoh_resource_preorder')) {
        const row = {
          preorder_id: `p-${active.length + 1}`,
          resource_id: 'mat-a',
          quantity: 1,
          reserved_qty: 1,
          issued_qty: 0,
          status: 'pending',
        };
        active = [...active, row];
        return [row];
      }
      return [];
    });
    const service = new ResourceService({ execute } as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 1 }]);

    const results = await Promise.allSettled([
      service.createPreorder('mat-a', 1),
      service.createPreorder('mat-a', 1),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(active).toHaveLength(1);
  });

  it('surfaces database failures as explainable errors', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('connection refused'));
    const service = new ResourceService({ execute } as never);

    await expect(service.getPreorder('missing')).rejects.toThrow(/failed/);
  });
});

describe('ResourceService audit', () => {
  const ACTOR = { userId: 'user-1', primaryOrgId: 'org-1' };
  const preorderRow = {
    preorder_id: 'p1',
    resource_id: 'mat-a',
    quantity: 5,
    reserved_qty: 5,
    issued_qty: 0,
    status: 'pending',
  };

  it('audits preorder reservation with the acting user and after state', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...preorderRow, quantity: 1, reserved_qty: 1 }]);
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceService(
      { execute } as never,
      auditService as never,
    );
    service.seedInventory([{ resourceId: 'mat-a', quantity: 1 }]);

    await service.createPreorder('mat-a', 1, ACTOR);

    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'resource.preorder',
        entityType: 'resource_preorder',
        entityId: 'p1',
        before: null,
        after: expect.objectContaining({
          resourceId: 'mat-a',
          quantity: 1,
          status: 'pending',
        }),
      }),
    );
  });

  it('audits issue with before/after issued quantity', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([preorderRow])
      .mockResolvedValueOnce([preorderRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ quantity: 5 }])
      .mockResolvedValueOnce([{ quantity: 3 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2, reserved_qty: 3 }]);
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceService(
      { execute } as never,
      auditService as never,
    );
    service.seedInventory([{ resourceId: 'mat-a', quantity: 5 }]);

    await service.issue('p1', 2, ACTOR);

    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'resource.issue',
        entityType: 'resource_preorder',
        entityId: 'p1',
        before: expect.objectContaining({ issuedQty: 0, status: 'pending' }),
        after: expect.objectContaining({ issuedQty: 2, status: 'pending' }),
      }),
    );
  });

  it('audits release with before/after state', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2 }])
      .mockResolvedValueOnce([{ ...preorderRow, issued_qty: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ quantity: 6 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...preorderRow, issued_qty: 2, status: 'released' },
      ]);
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceService(
      { execute } as never,
      auditService as never,
    );
    service.seedInventory([{ resourceId: 'mat-a', quantity: 3 }]);

    await service.release('p1', ACTOR);

    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'resource.release',
        entityType: 'resource_preorder',
        entityId: 'p1',
        before: expect.objectContaining({ issuedQty: 2, status: 'pending' }),
        after: expect.objectContaining({
          status: 'released',
          returnedQty: 3,
          reservedQty: 0,
        }),
      }),
    );
  });
});
