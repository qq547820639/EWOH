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
import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { ewohResourcePreorder, ewohResourceBinding } from '@server/database/schema';
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
  quantity: number | string;
  reserved_qty: number | string;
  issued_qty: number | string;
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

/**
 * 资源预占/发放/释放（ADR-081：drizzle 链式全量重写，raw SQL 清零）。
 *
 * 语义不变（与 ADR-078 前缀清理版逐一对应）：
 *  - 库存事实层 = ewoh_resource_binding（binding_type='inventory'，quantity 为权威值）；
 *  - 预占 = ewoh_resource_preorder（pending → issued → consumed/released）；
 *  - 发放扣减为条件更新（quantity >= issueQty 守卫，跨进程不超卖权威）；
 *  - 进程内 resourceLocks 串行化 + 条件更新双保险；
 *  - 写入携带 actor orgId（ADR-075/076 租户闭合；缺省走 DB GUC 默认）。
 * 读面按全局唯一 preorder_id 定位；读面 org 守卫列后续候选（NO-13ag）。
 */
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

  /**
   * R2-SNZ-009：非 global 请求缺租户上下文一律 fail-closed（原先读面
   * 无任何租户谓词，持他租户 preorderId 即可跨租户读/扣/还库存）。
   */
  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: resource operations require tenant context',
      );
    }
    return orgId;
  }

  /** global_admin 显式放行（与 RLS 例外路径一致）；其余强制本租户谓词。 */
  private orgCondition(
    column: typeof ewohResourcePreorder.orgId | typeof ewohResourceBinding.orgId,
    actor?: OrgContext,
  ): SQL | undefined {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    return eq(column, this.requireOrgId(actor)) as SQL;
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
        // NEST-631：可用量「检查-插入」以 pg_advisory_xact_lock 跨实例串行化
        // （原先仅进程内 withResourceLock，多实例并发可超卖预占）。
        // R2-SNZ-009：可用量聚合与写入均带租户谓词/显式 orgId（原先跨租户
        // 聚合可用量 + orgId 缺省省略）。
        const preorderOrgId = this.requireOrgId(actor);
        return this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`res:${resourceId}`}))`);
          await this.ensureSeededInventory(resourceId, actor);
          const inventoryQty = await this.loadInventoryQuantity(resourceId, actor);
          const active = await this.loadActivePreorders(resourceId, actor);
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
          const [row] = await this.safeExecute<PreorderRow>('create resource preorder', tx
            .insert(ewohResourcePreorder)
            .values({
              preorderId: preorder.id,
              resourceType: 'inventory',
              resourceId,
              quantity: sql`${quantity}`,
              reservedQty: sql`${quantity}`,
              issuedQty: sql`${0}`,
              consumedQty: sql`${0}`,
              returnedQty: sql`${0}`,
              status: 'pending',
              orgId: preorderOrgId,
            })
          .returning({
            preorder_id: ewohResourcePreorder.preorderId,
            resource_id: ewohResourcePreorder.resourceId,
            quantity: ewohResourcePreorder.quantity,
            reserved_qty: ewohResourcePreorder.reservedQty,
            issued_qty: ewohResourcePreorder.issuedQty,
            status: ewohResourcePreorder.status,
          }));
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
    // R2-SNZ-009：读面带租户谓词（global_admin 放行，缺租户 fail-closed）。
    const preorder = await this.getPreorder(preorderId, actor);
    return this.withResourceLock(preorder.resourceId, async () => {
      const fresh = await this.getPreorder(preorderId, actor);
      await this.ensureSeededInventory(fresh.resourceId, actor);
      const inventoryQty = await this.loadInventoryQuantity(fresh.resourceId, actor);
      if (!canIssue(fresh, inventoryQty, issueQty)) {
        throw new BadRequestException('Insufficient issue quantity');
      }
      const beforeIssued = fresh.issuedQty;
      const afterIssued = beforeIssued + issueQty;
      const status = afterIssued === fresh.quantity ? 'issued' : fresh.status;
      const [inventoryRow] = await this.safeExecute<InventoryRow>(
        'deduct inventory',
        this.db
          .update(ewohResourceBinding)
          .set({
            quantity: sql`${ewohResourceBinding.quantity} - ${issueQty}`,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(ewohResourceBinding.bindingType, 'inventory'),
            eq(ewohResourceBinding.resourceId, fresh.resourceId),
            eq(ewohResourceBinding.status, 'active'),
            gte(ewohResourceBinding.quantity, sql`${issueQty}`),
          ))
          .returning({ quantity: ewohResourceBinding.quantity }),
      );
      if (!inventoryRow) {
        throw new BadRequestException('Insufficient issue quantity');
      }
      this.inventory.set(fresh.resourceId, Number(inventoryRow.quantity));
      // R2-SNZ-010：issuedQty 改「增量 + CAS」更新（原先锁外读快照后绝对值
      // 覆盖写，多实例并发 issue 互相覆盖计数、binding 序号重复）。CAS 谓词
      // 含 issued_qty=beforeIssued 与 org；未命中 = 并发已变更，显式拒绝。
      const preorderOrgCond = this.orgCondition(ewohResourcePreorder.orgId, actor);
      const [updatedPreorder] = await this.safeExecute<PreorderRow>(
        'issue resource preorder',
        this.db
          .update(ewohResourcePreorder)
          .set({
            issuedQty: sql`${ewohResourcePreorder.issuedQty} + ${issueQty}`,
            reservedQty: sql`greatest(${ewohResourcePreorder.quantity} - ${ewohResourcePreorder.issuedQty} - ${issueQty}, 0)`,
            status,
            updatedAt: sql`now()`,
          })
          .where(
            preorderOrgCond
              ? and(
                  eq(ewohResourcePreorder.preorderId, preorderId),
                  eq(ewohResourcePreorder.issuedQty, sql`${beforeIssued}`),
                  preorderOrgCond,
                )
              : and(
                  eq(ewohResourcePreorder.preorderId, preorderId),
                  eq(ewohResourcePreorder.issuedQty, sql`${beforeIssued}`),
                ),
          )
          .returning({
            preorder_id: ewohResourcePreorder.preorderId,
            resource_id: ewohResourcePreorder.resourceId,
            quantity: ewohResourcePreorder.quantity,
            reserved_qty: ewohResourcePreorder.reservedQty,
            issued_qty: ewohResourcePreorder.issuedQty,
            status: ewohResourcePreorder.status,
          }),
      );
      if (!updatedPreorder) {
        throw new BadRequestException(
          'Concurrent issue detected on preorder; please retry',
        );
      }
      await this.safeExecute('persist resource binding', this.db
        .insert(ewohResourceBinding)
        .values({
          bindingId: nextId('bind'),
          bindingType: 'issue',
          resourceType: 'inventory',
          resourceId: fresh.resourceId,
          targetType: 'preorder',
          targetId: `${preorderId}#${beforeIssued + 1}-${afterIssued}`,
          startTime: sql`now()`,
          reason: `issue ${issueQty} of ${fresh.quantity}`,
          status: 'active',
          version: 1,
          // R2-SNZ-009：写入显式归属（原先 orgId 缺省省略）。
          orgId: this.requireOrgId(actor),
        }));
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
      return this.mapPreorder(updatedPreorder);
    });
  }

  async release(preorderId: string, actor?: OrgContext): Promise<Preorder> {
    // R2-SNZ-009：读面带租户谓词（global_admin 放行，缺租户 fail-closed）。
    const preorder = await this.getPreorder(preorderId, actor);
    // NEST-632：release 状态白名单——仅 pending/issued 可释放（原先
    // consumed/released 状态重复释放=库存重复返还）。
    if (preorder.status !== 'pending' && preorder.status !== 'issued') {
      throw new BadRequestException(
        `Preorder ${preorderId} cannot be released from status ${preorder.status} (only pending or issued)`,
      );
    }
    return this.withResourceLock(preorder.resourceId, async () => {
      const fresh = await this.getPreorder(preorderId, actor);
      // 锁内复核状态（锁外检查与锁内执行间状态可能被并发改变）。
      if (fresh.status !== 'pending' && fresh.status !== 'issued') {
        throw new BadRequestException(
          `Preorder ${preorderId} cannot be released from status ${fresh.status} (only pending or issued)`,
        );
      }
      const remaining = fresh.quantity - fresh.issuedQty;
      await this.ensureSeededInventory(fresh.resourceId, actor);
      const [releasedRow] = await this.safeExecute<InventoryRow>(
        'add back inventory quantity',
        this.db
          .update(ewohResourceBinding)
          .set({
            quantity: sql`${ewohResourceBinding.quantity} + ${remaining}`,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(ewohResourceBinding.bindingType, 'inventory'),
            eq(ewohResourceBinding.resourceId, fresh.resourceId),
            eq(ewohResourceBinding.status, 'active'),
          ))
          .returning({ quantity: ewohResourceBinding.quantity }),
      );
      if (releasedRow) {
        this.inventory.set(fresh.resourceId, Number(releasedRow.quantity));
      } else {
        await this.safeExecute('persist released inventory', this.db
          .insert(ewohResourceBinding)
          .values({
            bindingId: nextId('inventory'),
            bindingType: 'inventory',
            resourceType: 'inventory',
            resourceId: fresh.resourceId,
            targetType: 'inventory',
            targetId: fresh.resourceId,
            startTime: sql`now()`,
            reason: 'release returned quantity',
            status: 'active',
            quantity: sql`${remaining}`,
            orgId: this.requireOrgId(actor),
          }));
        this.inventory.set(fresh.resourceId, remaining);
      }
      // R2-SNZ-009/010：释放 update 带租户谓词 + status CAS（锁外复核与
      // 写入间的并发状态变更显式拒绝，绝不静默覆盖）。
      const releaseOrgCond = this.orgCondition(ewohResourcePreorder.orgId, actor);
      const [releasedPreorder] = await this.safeExecute<PreorderRow>(
        'release resource preorder',
        this.db
          .update(ewohResourcePreorder)
          .set({
            status: 'released',
            reservedQty: sql`${0}`,
            returnedQty: sql`${remaining}`,
            endTime: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            releaseOrgCond
              ? and(
                  eq(ewohResourcePreorder.preorderId, preorderId),
                  eq(ewohResourcePreorder.status, fresh.status),
                  releaseOrgCond,
                )
              : and(
                  eq(ewohResourcePreorder.preorderId, preorderId),
                  eq(ewohResourcePreorder.status, fresh.status),
                ),
          )
          .returning({
            preorder_id: ewohResourcePreorder.preorderId,
            resource_id: ewohResourcePreorder.resourceId,
            quantity: ewohResourcePreorder.quantity,
            reserved_qty: ewohResourcePreorder.reservedQty,
            issued_qty: ewohResourcePreorder.issuedQty,
            status: ewohResourcePreorder.status,
          }),
      );
      if (!releasedPreorder) {
        throw new BadRequestException(
          `Preorder ${preorderId} changed concurrently; please retry`,
        );
      }
      await this.safeExecute('persist resource release binding', this.db
        .insert(ewohResourceBinding)
        .values({
          bindingId: nextId('bind'),
          bindingType: 'release',
          resourceType: 'inventory',
          resourceId: fresh.resourceId,
          targetType: 'preorder',
          targetId: preorderId,
          startTime: sql`now()`,
          endTime: sql`now()`,
          reason: 'release reservation',
          status: 'released',
          version: 1,
          orgId: this.requireOrgId(actor),
        }));
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
      return this.mapPreorder(releasedPreorder);
    });
  }

  /**
   * R2-SNZ-009：读面带租户谓词（global_admin 放行；非 global 缺租户
   * fail-closed 400，他租户 preorderId 一律 404）。
   */
  async getPreorder(preorderId: string, actor?: OrgContext): Promise<Preorder> {
    const orgCond = this.orgCondition(ewohResourcePreorder.orgId, actor);
    const rows = await this.safeExecute<PreorderRow>('read resource preorder', this.db
      .select({
        preorder_id: ewohResourcePreorder.preorderId,
        resource_id: ewohResourcePreorder.resourceId,
        quantity: ewohResourcePreorder.quantity,
        reserved_qty: ewohResourcePreorder.reservedQty,
        issued_qty: ewohResourcePreorder.issuedQty,
        status: ewohResourcePreorder.status,
      })
      .from(ewohResourcePreorder)
      .where(
        orgCond
          ? and(eq(ewohResourcePreorder.preorderId, preorderId), orgCond)
          : eq(ewohResourcePreorder.preorderId, preorderId),
      ));
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`Preorder ${preorderId} not found`);
    }
    return this.mapPreorder(row);
  }

  /** R2-SNZ-009：可用量聚合按调用者租户过滤（原先跨租户聚合）。 */
  private async loadActivePreorders(resourceId: string, actor?: OrgContext): Promise<Preorder[]> {
    const orgCond = this.orgCondition(ewohResourcePreorder.orgId, actor);
    const rows = await this.safeExecute<PreorderRow>('read active resource preorders', this.db
      .select({
        preorder_id: ewohResourcePreorder.preorderId,
        resource_id: ewohResourcePreorder.resourceId,
        quantity: ewohResourcePreorder.quantity,
        reserved_qty: ewohResourcePreorder.reservedQty,
        issued_qty: ewohResourcePreorder.issuedQty,
        status: ewohResourcePreorder.status,
      })
      .from(ewohResourcePreorder)
      .where(
        orgCond
          ? and(
              eq(ewohResourcePreorder.resourceId, resourceId),
              inArray(ewohResourcePreorder.status, ['pending', 'issued']),
              orgCond,
            )
          : and(
              eq(ewohResourcePreorder.resourceId, resourceId),
              inArray(ewohResourcePreorder.status, ['pending', 'issued']),
            ),
      ));
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

  /** R2-SNZ-009：库存行读取同样限定调用者租户（与 preorder 谓词一致）。 */
  private async loadInventoryQuantity(resourceId: string, actor?: OrgContext): Promise<number> {
    const orgCond = this.orgCondition(ewohResourceBinding.orgId, actor);
    const rows = await this.safeExecute<InventoryRow>('read inventory quantity', this.db
      .select({ quantity: ewohResourceBinding.quantity })
      .from(ewohResourceBinding)
      .where(
        orgCond
          ? and(
              eq(ewohResourceBinding.bindingType, 'inventory'),
              eq(ewohResourceBinding.resourceId, resourceId),
              eq(ewohResourceBinding.status, 'active'),
              orgCond,
            )
          : and(
              eq(ewohResourceBinding.bindingType, 'inventory'),
              eq(ewohResourceBinding.resourceId, resourceId),
              eq(ewohResourceBinding.status, 'active'),
            ),
      )
      .limit(1));
    const row = rows[0];
    if (!row) {
      return this.getInventory(resourceId);
    }
    const quantity = Number(row.quantity);
    this.inventory.set(resourceId, quantity);
    return quantity;
  }

  private async ensureSeededInventory(resourceId: string, actor?: OrgContext): Promise<void> {
    const seededQuantity = this.inventory.get(resourceId);
    if (seededQuantity === undefined || this.persistedSeeds.has(resourceId)) {
      return;
    }
    await this.safeExecute('persist seeded inventory', this.db
      .insert(ewohResourceBinding)
      .values({
        bindingId: nextId('inventory'),
        bindingType: 'inventory',
        resourceType: 'inventory',
        resourceId,
        targetType: 'inventory',
        targetId: resourceId,
        startTime: sql`now()`,
        reason: 'seeded inventory baseline',
        status: 'active',
        quantity: sql`${seededQuantity}`,
        orgId: this.requireOrgId(actor),
      })
      .onConflictDoUpdate({
        target: [
          ewohResourceBinding.orgId,
          ewohResourceBinding.resourceId,
          ewohResourceBinding.targetId,
          ewohResourceBinding.bindingType,
        ],
        set: {
          quantity: sql`${seededQuantity}`,
          status: 'active',
          updatedAt: sql`now()`,
        },
      }));
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

  private async safeExecute<T>(context: string, query: Promise<T[]>): Promise<T[]> {
    try {
      return await query;
    } catch (error) {
      this.logger.error(
        `${context} failed`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new InternalServerErrorException(`${context} failed`);
    }
  }
}
