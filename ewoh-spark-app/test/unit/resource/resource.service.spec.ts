import { and, eq, gte, sql } from 'drizzle-orm';
import { ewohResourceBinding } from '@server/database/schema';
import {
  ResourceService,
  availableQuantity,
  canIssue,
} from '../../../server/modules/resource/resource.service';
import { makeResourceDb } from '../../helpers/fake-resource-db';

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

// R2-SNZ-009/010：读写谓词按 org 过滤——seed 行携带租户归属（org-1）。
const INVENTORY_BINDING = {
  binding_id: 'b1',
  binding_type: 'inventory',
  resource_type: 'inventory',
  resource_id: 'mat-a',
  target_type: 'inventory',
  target_id: 'mat-a',
  status: 'active',
  quantity: 5,
  org_id: 'org-1',
};

const PENDING_PREORDER = {
  preorder_id: 'p1',
  resource_id: 'mat-a',
  quantity: 5,
  reserved_qty: 5,
  issued_qty: 0,
  status: 'pending',
  org_id: 'org-1',
};

describe('ResourceService persistence（ADR-081 drizzle 链式语义假库）', () => {
  // R2-SNZ：资源读写显式租户上下文（无 actor fail-closed 400）。
  const ACTOR = { userId: 'planner-1', primaryOrgId: 'org-1' };

  it('persists preorders and rejects oversell', async () => {
    const fake = makeResourceDb();
    const service = new ResourceService(fake.db as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 1 }]);

    const preorder = await service.createPreorder('mat-a', 1, ACTOR);

    expect(preorder.resourceId).toBe('mat-a');
    expect(preorder.quantity).toBe(1);
    expect(preorder.status).toBe('pending');
    expect(fake.preorderRows).toHaveLength(1);
    expect(fake.preorderRows[0].resource_id).toBe('mat-a');
    expect(
      fake.bindingRows.some(
        (r) => r.binding_type === 'inventory' && Number(r.quantity) === 1,
      ),
    ).toBe(true);
    await expect(service.createPreorder('mat-a', 1, ACTOR)).rejects.toThrow(
      'Insufficient available quantity',
    );
    expect(fake.preorderRows).toHaveLength(1);
  });

  it('persists issue updates, inventory deduction, and a resource binding', async () => {
    const fake = makeResourceDb();
    const service = new ResourceService(fake.db as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 5 }]);
    const preorder = await service.createPreorder('mat-a', 5, ACTOR);

    const result = await service.issue(preorder.id, 2, ACTOR);

    expect(result.issuedQty).toBe(2);
    expect(service.getInventory('mat-a')).toBe(3);
    const inventoryRow = fake.bindingRows.find((r) => r.binding_type === 'inventory');
    expect(Number(inventoryRow?.quantity)).toBe(3);
    expect(
      fake.bindingRows.some(
        (r) => r.binding_type === 'issue' && r.target_type === 'preorder',
      ),
    ).toBe(true);
    expect(Number(fake.preorderRows[0].issued_qty)).toBe(2);
    expect(Number(fake.preorderRows[0].reserved_qty)).toBe(3);
  });

  it('returns released quantity to inventory and records a release binding', async () => {
    const fake = makeResourceDb({
      preorders: [
        { ...PENDING_PREORDER, reserved_qty: 3, issued_qty: 2 },
      ],
      bindings: [{ ...INVENTORY_BINDING, quantity: 6 }],
    });
    const service = new ResourceService(fake.db as never);

    const result = await service.release('p1', ACTOR);

    expect(result.status).toBe('released');
    expect(service.getInventory('mat-a')).toBe(9);
    expect(
      fake.bindingRows.some((r) => r.binding_type === 'release' && r.status === 'released'),
    ).toBe(true);
    expect(fake.preorderRows[0].status).toBe('released');
    expect(Number(fake.preorderRows[0].returned_qty)).toBe(3);
    expect(Number(fake.preorderRows[0].reserved_qty)).toBe(0);
  });

  it('persists released inventory when no inventory binding row exists', async () => {
    const fake = makeResourceDb({
      preorders: [{ ...PENDING_PREORDER, reserved_qty: 3, issued_qty: 2 }],
    });
    const service = new ResourceService(fake.db as never);

    const result = await service.release('p1', ACTOR);

    expect(result.status).toBe('released');
    expect(service.getInventory('mat-a')).toBe(3);
    const seeded = fake.bindingRows.find((r) => r.binding_type === 'inventory');
    expect(seeded).toBeDefined();
    expect(Number(seeded?.quantity)).toBe(3);
  });

  it('rejects issue when the inventory binding quantity is below the issue quantity', async () => {
    const fake = makeResourceDb({
      preorders: [PENDING_PREORDER],
      bindings: [{ ...INVENTORY_BINDING, quantity: 1 }],
    });
    const service = new ResourceService(fake.db as never);

    await expect(service.issue('p1', 2, ACTOR)).rejects.toThrow('Insufficient issue quantity');
    expect(service.getInventory('mat-a')).toBe(1);
  });

  it('serializes concurrent preorders so inventory is never oversold', async () => {
    const fake = makeResourceDb();
    const service = new ResourceService(fake.db as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 1 }]);

    const results = await Promise.allSettled([
      service.createPreorder('mat-a', 1, ACTOR),
      service.createPreorder('mat-a', 1, ACTOR),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(fake.preorderRows).toHaveLength(1);
  });

  it('throws NotFound for a missing preorder', async () => {
    const service = new ResourceService(makeResourceDb().db as never);

    await expect(service.getPreorder('missing', ACTOR)).rejects.toThrow('Preorder missing not found');
  });

  it('surfaces database failures as explainable errors', async () => {
    const service = new ResourceService(makeResourceDb({ failSelect: true }).db as never);

    await expect(service.getPreorder('p1', ACTOR)).rejects.toThrow(/failed/);
  });
});

describe('fake-resource-db conditional authority（gte 守卫，§31）', () => {
  const deductChain = (fake: { db: any; bindingRows: Array<Record<string, unknown>> }) =>
    fake.db.update(ewohResourceBinding)
      .set({ quantity: sql`${ewohResourceBinding.quantity} - ${2}` })
      .where(and(
        eq(ewohResourceBinding.bindingType, 'inventory'),
        eq(ewohResourceBinding.resourceId, 'mat-a'),
        eq(ewohResourceBinding.status, 'active'),
        gte(ewohResourceBinding.quantity, sql`${2}`),
      ))
      .returning({ quantity: ewohResourceBinding.quantity });

  it('conditional quantity update returns zero rows when quantity is insufficient', async () => {
    const fake = makeResourceDb({
      bindings: [{ ...INVENTORY_BINDING, quantity: 1 }],
    });

    const rows = await deductChain(fake as never);

    expect(rows).toHaveLength(0);
    expect(Number(fake.bindingRows[0].quantity)).toBe(1);
  });

  it('conditional quantity update deducts when quantity suffices', async () => {
    const fake = makeResourceDb({
      bindings: [{ ...INVENTORY_BINDING, quantity: 5 }],
    });

    const rows = await deductChain(fake as never);

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(3);
    expect(Number(fake.bindingRows[0].quantity)).toBe(3);
  });
});

describe('ResourceService audit', () => {
  const ACTOR = { userId: 'user-1', primaryOrgId: 'org-1' };

  it('audits preorder reservation with the acting user, org, and after state', async () => {
    const fake = makeResourceDb();
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceService(fake.db as never, auditService as never);
    service.seedInventory([{ resourceId: 'mat-a', quantity: 1 }]);

    await service.createPreorder('mat-a', 1, ACTOR);

    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'resource.preorder',
        entityType: 'resource_preorder',
        entityId: expect.any(String),
        before: null,
        after: expect.objectContaining({
          resourceId: 'mat-a',
          quantity: 1,
          status: 'pending',
        }),
      }),
    );
    // ADR-075/081：写入携带 actor orgId（租户闭合）。
    expect(fake.preorderRows[0].org_id).toBe('org-1');
  });

  it('audits issue with before/after issued quantity and org-scoped binding', async () => {
    const fake = makeResourceDb({
      preorders: [PENDING_PREORDER],
      bindings: [INVENTORY_BINDING],
    });
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceService(fake.db as never, auditService as never);

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
    expect(fake.bindingRows.find((r) => r.binding_type === 'issue')?.org_id).toBe('org-1');
  });

  it('audits release with before/after state and org-scoped release binding', async () => {
    const fake = makeResourceDb({
      preorders: [{ ...PENDING_PREORDER, reserved_qty: 3, issued_qty: 2 }],
      bindings: [{ ...INVENTORY_BINDING, quantity: 6 }],
    });
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceService(fake.db as never, auditService as never);

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
    expect(fake.bindingRows.find((r) => r.binding_type === 'release')?.org_id).toBe('org-1');
  });
});
