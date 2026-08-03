import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql, type SQL } from 'drizzle-orm';
import { AuditService, type AuditLogEntry } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface InventoryItem {
  resourceId: string;
  quantity: number;
}

export interface Preorder {
  id: string;
  resourceId: string;
  quantity: number;
  issuedQty: number;
  status: 'pending' | 'issued' | 'consumed' | 'released';
}

interface PreorderRow {
  preorder_id: string;
  resource_id: string;
  quantity: number;
  reserved_qty: number;
  issued_qty: number;
  status: string;
}

interface InventoryRow {
  quantity: number | string;
}

let seq = 0;

function nextId(prefix = 'preorder'): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export function availableQuantity(inventoryQty: number, preorders: Preorder[]): number {
  const reserved = preorders
    .filter((preorder) => preorder.status === 'pending' || preorder.status === 'issued')
    .reduce((sum, preorder) => sum + (preorder.quantity - preorder.issuedQty), 0);
  return inventoryQty - reserved;
}

export function canIssue(preorder: Preorder, inventoryQty: number, issueQty: number): boolean {
  const unissued = preorder.quantity - preorder.issuedQty;
  return unissued >= issueQty && inventoryQty >= issueQty;
}

@Injectable()
export class ResourceService {
  private readonly inventory = new Map<string, number>();
  private readonly resourceLocks = new Map<string, Promise<unknown>>();
  private readonly persistedSeeds = new Set<string>();
  private readonly logger = new Logger(ResourceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  seedInventory(items: InventoryItem[]): void {
    for (const item of items) {
      this.inventory.set(item.resourceId, item.quantity);
    }
  }

  getInventory(resourceId: string): number {
    return this.inventory.get(resourceId) ?? 0;
  }

  async createPreorder(
    resourceId: string,
    quantity: number,
    actor?: OrgContext,
  ): Promise<Preorder> {
    if (!resourceId?.trim() || quantity <= 0) {
      throw new BadRequestException('resourceId and positive quantity are required');
    }
    return this.withResourceLock(resourceId, async () => {
      await this.ensureSeededInventory(resourceId);
      const inventoryQty = await this.loadInventoryQuantity(resourceId);
      const active = await this.loadActivePreorders(resourceId);
      if (availableQuantity(inventoryQty, active) < quantity) {
        throw new BadRequestException('Insufficient available quantity');
      }
      const preorder: Preorder = {
        id: nextId(),
        resourceId,
        quantity,
        issuedQty: 0,
        status: 'pending',
      };
      const [row] = await this.safeExecute<PreorderRow>('create resource preorder', sql`
        insert into public.ewoh_resource_preorder (
          preorder_id, resource_type, resource_id, quantity, reserved_qty,
          issued_qty, consumed_qty, returned_qty, status
        ) values (
          ${preorder.id}, 'inventory', ${resourceId}, ${quantity}, ${quantity},
          0, 0, 0, 'pending'
        )
        returning preorder_id, resource_id, quantity, reserved_qty, issued_qty, status
      `);
      const created = this.mapPreorder(row);
      await this.recordAudit(
        {
          action: 'resource.preorder',
          entityType: 'resource_preorder',
          entityId: created.id,
          before: null,
          after: {
            resourceId: created.resourceId,
            quantity: created.quantity,
            status: created.status,
          },
        },
        actor,
      );
      return created;
    });
  }

  async issue(
    preorderId: string,
    issueQty: number,
    actor?: OrgContext,
  ): Promise<Preorder> {
    if (!Number.isFinite(issueQty) || issueQty <= 0) {
      throw new BadRequestException('Positive issue quantity is required');
    }
    const preorder = await this.getPreorder(preorderId);
    return this.withResourceLock(preorder.resourceId, async () => {
      const fresh = await this.getPreorder(preorderId);
      await this.ensureSeededInventory(fresh.resourceId);
      const inventoryQty = await this.loadInventoryQuantity(fresh.resourceId);
      if (!canIssue(fresh, inventoryQty, issueQty)) {
        throw new BadRequestException('Insufficient issue quantity');
      }
      const beforeIssued = fresh.issuedQty;
      const afterIssued = beforeIssued + issueQty;
      const status = afterIssued === fresh.quantity ? 'issued' : fresh.status;
      const [inventoryRow] = await this.safeExecute<InventoryRow>(
        'deduct inventory',
        sql`
          update public.ewoh_resource_binding
          set quantity = quantity - ${issueQty}, _updated_at = now()
          where binding_type = 'inventory' and resource_id = ${fresh.resourceId}
            and status = 'active' and quantity >= ${issueQty}
          returning quantity
        `,
      );
      if (!inventoryRow) {
        throw new BadRequestException('Insufficient issue quantity');
      }
      this.inventory.set(fresh.resourceId, Number(inventoryRow.quantity));
      await this.safeExecute('issue resource preorder', sql`
        update public.ewoh_resource_preorder
        set issued_qty = ${afterIssued},
            reserved_qty = ${Math.max(0, fresh.quantity - afterIssued)},
            status = ${status},
            _updated_at = now()
        where preorder_id = ${preorderId}
      `);
      await this.safeExecute('persist resource binding', sql`
        insert into public.ewoh_resource_binding (
          binding_id, binding_type, resource_type, resource_id, target_type, target_id,
          start_time, reason, status, version
        ) values (
          ${nextId('bind')}, 'issue', 'inventory', ${fresh.resourceId}, 'preorder',
          ${`${preorderId}#${beforeIssued + 1}-${afterIssued}`}, now(),
          ${`issue ${issueQty} of ${fresh.quantity}`}, 'active', 1
        )
      `);
      await this.recordAudit(
        {
          action: 'resource.issue',
          entityType: 'resource_preorder',
          entityId: preorderId,
          before: {
            issuedQty: beforeIssued,
            status: fresh.status,
          },
          after: {
            issuedQty: afterIssued,
            status,
          },
        },
        actor,
      );
      return this.getPreorder(preorderId);
    });
  }

  async release(preorderId: string, actor?: OrgContext): Promise<Preorder> {
    const preorder = await this.getPreorder(preorderId);
    return this.withResourceLock(preorder.resourceId, async () => {
      const fresh = await this.getPreorder(preorderId);
      const remaining = fresh.quantity - fresh.issuedQty;
      await this.ensureSeededInventory(fresh.resourceId);
      const [releasedRow] = await this.safeExecute<InventoryRow>(
        'add back inventory quantity',
        sql`
          update public.ewoh_resource_binding
          set quantity = quantity + ${remaining}, _updated_at = now()
          where binding_type = 'inventory' and resource_id = ${fresh.resourceId}
            and status = 'active'
          returning quantity
        `,
      );
      if (releasedRow) {
        this.inventory.set(fresh.resourceId, Number(releasedRow.quantity));
      } else {
        await this.safeExecute('persist released inventory', sql`
          insert into public.ewoh_resource_binding (
            binding_id, binding_type, resource_type, resource_id, target_type, target_id,
            start_time, reason, status, quantity
          ) values (
            ${nextId('inventory')}, 'inventory', 'inventory', ${fresh.resourceId}, 'inventory',
            ${fresh.resourceId}, now(), 'release returned quantity', 'active', ${remaining}
          )
        `);
        this.inventory.set(fresh.resourceId, remaining);
      }
      await this.safeExecute('release resource preorder', sql`
        update public.ewoh_resource_preorder
        set status = 'released', reserved_qty = 0, returned_qty = ${remaining},
            end_time = now(), _updated_at = now()
        where preorder_id = ${preorderId}
      `);
      await this.safeExecute('persist resource release binding', sql`
        insert into public.ewoh_resource_binding (
          binding_id, binding_type, resource_type, resource_id, target_type, target_id,
          start_time, end_time, reason, status, version
        ) values (
          ${nextId('bind')}, 'release', 'inventory', ${fresh.resourceId}, 'preorder',
          ${preorderId}, now(), now(), 'release reservation', 'released', 1
        )
      `);
      await this.recordAudit(
        {
          action: 'resource.release',
          entityType: 'resource_preorder',
          entityId: preorderId,
          before: {
            issuedQty: fresh.issuedQty,
            status: fresh.status,
          },
          after: {
            status: 'released',
            returnedQty: remaining,
            reservedQty: 0,
          },
        },
        actor,
      );
      return this.getPreorder(preorderId);
    });
  }

  async getPreorder(preorderId: string): Promise<Preorder> {
    const rows = await this.safeExecute<PreorderRow>('read resource preorder', sql`
      select preorder_id, resource_id, quantity, reserved_qty, issued_qty, status
      from public.ewoh_resource_preorder
      where preorder_id = ${preorderId}
    `);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`Preorder ${preorderId} not found`);
    }
    return this.mapPreorder(row);
  }

  private async loadActivePreorders(resourceId: string): Promise<Preorder[]> {
    const rows = await this.safeExecute<PreorderRow>('read active resource preorders', sql`
      select preorder_id, resource_id, quantity, reserved_qty, issued_qty, status
      from public.ewoh_resource_preorder
      where resource_id = ${resourceId} and status in ('pending', 'issued')
    `);
    return rows.map((row) => this.mapPreorder(row));
  }

  private mapPreorder(row: PreorderRow): Preorder {
    return {
      id: row.preorder_id,
      resourceId: row.resource_id,
      quantity: Number(row.quantity),
      issuedQty: Number(row.issued_qty),
      status: row.status as Preorder['status'],
    };
  }

  private async loadInventoryQuantity(resourceId: string): Promise<number> {
    const rows = await this.safeExecute<InventoryRow>('read inventory quantity', sql`
      select quantity
      from public.ewoh_resource_binding
      where binding_type = 'inventory' and resource_id = ${resourceId}
        and status = 'active'
      limit 1
    `);
    const row = rows[0];
    if (!row) {
      return this.getInventory(resourceId);
    }
    const quantity = Number(row.quantity);
    this.inventory.set(resourceId, quantity);
    return quantity;
  }

  private async ensureSeededInventory(resourceId: string): Promise<void> {
    const seededQuantity = this.inventory.get(resourceId);
    if (seededQuantity === undefined || this.persistedSeeds.has(resourceId)) {
      return;
    }
    await this.safeExecute('persist seeded inventory', sql`
      insert into public.ewoh_resource_binding (
        binding_id, binding_type, resource_type, resource_id, target_type, target_id,
        start_time, reason, status, quantity
      ) values (
        ${nextId('inventory')}, 'inventory', 'inventory', ${resourceId}, 'inventory',
        ${resourceId}, now(), 'seeded inventory baseline', 'active', ${seededQuantity}
      )
      on conflict (org_id, resource_id, target_id, binding_type)
      do update set quantity = ${seededQuantity}, status = 'active', _updated_at = now()
    `);
    this.persistedSeeds.add(resourceId);
  }

  /**
   * Inventory facts live in ewoh_resource_binding (binding_type='inventory').
   * The per-resource lock serializes this process; the conditional quantity
   * update is the cross-process no-oversell authority.
   */
  private withResourceLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resourceLocks.get(resourceId) ?? Promise.resolve();
    const run = previous.then(() => operation());
    this.resourceLocks.set(resourceId, run.catch(() => undefined));
    return run;
  }

  private async recordAudit(
    entry: Omit<AuditLogEntry, 'actorId' | 'orgId'>,
    actor?: OrgContext,
  ): Promise<void> {
    if (!this.auditService) {
      return;
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      ...entry,
    });
  }

  private async safeExecute<T>(context: string, query: SQL): Promise<T[]> {
    try {
      return (await this.db.execute(query)) as T[];
    } catch (error) {
      this.logger.error(
        `${context} failed`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new InternalServerErrorException(`${context} failed`);
    }
  }
}
