import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../shared/audit.service';
import {
  canAccessWorkbenchRole,
  WORKBENCH_ROLES,
  type WorkbenchRole,
} from './workbench-access';

/**
 * Server-side saved-view persistence for the Role Workbench.
 *
 * Previously the "save view" feature only wrote to the browser's localStorage,
 * so a view was per-device and could not be shared. Here the server is the
 * source of truth: a view is stored under the owning user + org, can be marked
 * `shared` so other members of the same org can read it (cross-device /
 * cross-user), and mutating it is gated by ownership.
 *
 * The store is injectable: the default in-memory implementation works in unit
 * tests and single-instance dev. Durable, multi-instance, cross-device storage
 * across restarts requires a database-backed store + migration and is therefore
 * `BLOCKED_BY_ENVIRONMENT`.
 */

export interface WorkbenchView {
  key: string;
  role: string;
  listKey: string;
  ownerId: string;
  orgId: string;
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchViewInput {
  key: string;
  role: string;
  listKey: string;
  filter?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  shared?: boolean;
}

/** Supported (role, list) pairs mirror the server-backed Role Workbench schema. */
const WORKBENCH_ROLE_LIST_KEYS: Readonly<Record<WorkbenchRole, ReadonlySet<string>>> = {
  operator: new Set(['mySteps']),
  team_lead: new Set(['delayedOrders']),
  quality: new Set(['duplicateDefects', 'defectPareto']),
  equipment: new Set(['abnormalDevices', 'downtimeReasons', 'maintenanceTasks', 'capacityDegradation']),
  manager: new Set(['riskTrend']),
};

export interface WorkbenchViewStore {
  save(view: WorkbenchView): Promise<WorkbenchView>;
  get(orgId: string, ownerId: string, key: string): Promise<WorkbenchView | undefined>;
  /** Resolve an own or same-org shared view for an authorization check. */
  getVisible(
    orgId: string,
    requesterId: string,
    key: string,
  ): Promise<WorkbenchView | undefined>;
  list(ownerId: string, orgId: string): Promise<WorkbenchView[]>;
  remove(orgId: string, ownerId: string, key: string): Promise<void>;
}

export class InMemoryWorkbenchViewStore implements WorkbenchViewStore {
  // R2-SOP-019：Map 键含 (orgId, ownerId, key) 三元组——跨 org/owner 同名
  // 视图不再互相覆盖/误删（与 PostgresWorkbenchViewStore 的谓词语义对齐）。
  private readonly views = new Map<string, WorkbenchView>();

  private scopedKey(orgId: string, ownerId: string, key: string): string {
    return `${orgId}::${ownerId}::${key}`;
  }

  async save(view: WorkbenchView): Promise<WorkbenchView> {
    this.views.set(this.scopedKey(view.orgId, view.ownerId, view.key), view);
    return view;
  }

  async get(orgId: string, ownerId: string, key: string): Promise<WorkbenchView | undefined> {
    return this.views.get(this.scopedKey(orgId, ownerId, key));
  }

  async getVisible(
    orgId: string,
    requesterId: string,
    key: string,
  ): Promise<WorkbenchView | undefined> {
    return [...this.views.values()].find(
      (view) =>
        view.orgId === orgId &&
        view.key === key &&
        (view.ownerId === requesterId || view.shared),
    );
  }

  async list(ownerId: string, orgId: string): Promise<WorkbenchView[]> {
    return [...this.views.values()].filter(
      (view) => view.orgId === orgId && (view.ownerId === ownerId || view.shared),
    );
  }

  async remove(orgId: string, ownerId: string, key: string): Promise<void> {
    this.views.delete(this.scopedKey(orgId, ownerId, key));
  }

  clear(): void {
    this.views.clear();
  }
}

export const WORKBENCH_VIEW_STORE = Symbol('WORKBENCH_VIEW_STORE');

export interface WorkbenchViewActor {
  userId: string;
  primaryOrgId: string;
  roles?: string[];
}

@Injectable()
export class WorkbenchViewService {
  constructor(
    @Optional() @Inject(WORKBENCH_VIEW_STORE)
    private readonly store: WorkbenchViewStore = new InMemoryWorkbenchViewStore(),
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private isAdmin(actor: WorkbenchViewActor): boolean {
    return (actor.roles ?? []).includes('global_admin');
  }

  /** Upserts a saved view. The owner is always the authenticated actor. */
  async saveView(
    actor: WorkbenchViewActor,
    input: WorkbenchViewInput,
  ): Promise<WorkbenchView> {
    const key = (input.key ?? '').trim();
    const role = (input.role ?? '').trim() as WorkbenchRole;
    const listKey = (input.listKey ?? '').trim();
    if (!key || !role || !listKey) {
      throw new BadRequestException('view requires key, role and listKey');
    }
    if (key.length > 200 || listKey.length > 100) {
      throw new BadRequestException('view key or listKey is too long');
    }
    if (!WORKBENCH_ROLES.includes(role)) {
      throw new BadRequestException('view role is invalid');
    }
    if (!canAccessWorkbenchRole(actor.roles ?? [], role)) {
      throw new ForbiddenException(
        `You are not authorized to save the '${role}' workbench view`,
      );
    }
    if (!WORKBENCH_ROLE_LIST_KEYS[role]?.has(listKey)) {
      throw new BadRequestException('view listKey is invalid for this workbench role');
    }
    // The client's serverViewKey contract is `${role}.${listKey}`. Enforce it so
    // a stored view can never advertise one role/list while applying another.
    if (key !== `${role}.${listKey}`) {
      throw new BadRequestException('view key must match role and listKey');
    }
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    ) {
      throw new BadRequestException('view limit must be between 1 and 100');
    }
    const now = new Date().toISOString();
    const existing = await this.store.get(actor.primaryOrgId, actor.userId, key);
    const view: WorkbenchView = {
      key,
      role,
      listKey,
      ownerId: actor.userId,
      orgId: actor.primaryOrgId,
      filter: input.filter?.trim() || undefined,
      sortKey: input.sortKey?.trim() || undefined,
      sortDir: input.sortDir,
      limit: input.limit,
      shared: input.shared ?? existing?.shared ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.save(view);
    await this.auditService?.appendAuditLog({
      actorId: actor.userId,
      orgId: actor.primaryOrgId,
      action: existing ? 'workbench.view.updated' : 'workbench.view.created',
      entityType: 'workbench_view',
      entityId: view.key,
      metadata: { role: view.role, listKey: view.listKey },
    });
    return view;
  }

  /** Lists own + org-shared views (cross-device sync source of truth). */
  async listViews(actor: WorkbenchViewActor): Promise<WorkbenchView[]> {
    return this.store.list(actor.userId, actor.primaryOrgId);
  }

  /** Removes a view; only the owner (or a global admin) may delete it. */
  async deleteView(actor: WorkbenchViewActor, key: string): Promise<void> {
    // list() exposes own + shared views, so authorization must resolve the same
    // visibility; looking up only actor-owned rows made shared views impossible
    // to delete (even for global admins).
    const existing = await this.store.getVisible(actor.primaryOrgId, actor.userId, key);
    if (!existing) {
      throw new NotFoundException('view not found');
    }
    if (existing.ownerId !== actor.userId && !this.isAdmin(actor)) {
      throw new ForbiddenException('You may only delete your own saved views');
    }
    await this.store.remove(actor.primaryOrgId, existing.ownerId, key);
    await this.auditService?.appendAuditLog({
      actorId: actor.userId,
      orgId: actor.primaryOrgId,
      action: 'workbench.view.deleted',
      entityType: 'workbench_view',
      entityId: key,
    });
  }
}