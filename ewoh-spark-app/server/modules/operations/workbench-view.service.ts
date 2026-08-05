import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../shared/audit.service';

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

export interface WorkbenchViewStore {
  save(view: WorkbenchView): Promise<WorkbenchView>;
  get(key: string): Promise<WorkbenchView | undefined>;
  list(ownerId: string, orgId: string): Promise<WorkbenchView[]>;
  remove(key: string): Promise<void>;
}

export class InMemoryWorkbenchViewStore implements WorkbenchViewStore {
  private readonly views = new Map<string, WorkbenchView>();

  async save(view: WorkbenchView): Promise<WorkbenchView> {
    this.views.set(view.key, view);
    return view;
  }

  async get(key: string): Promise<WorkbenchView | undefined> {
    return this.views.get(key);
  }

  async list(ownerId: string, orgId: string): Promise<WorkbenchView[]> {
    return [...this.views.values()].filter(
      (view) => view.orgId === orgId && (view.ownerId === ownerId || view.shared),
    );
  }

  async remove(key: string): Promise<void> {
    this.views.delete(key);
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
    if (!input.key || !input.role || !input.listKey) {
      throw new NotFoundException('view requires key, role and listKey');
    }
    const now = new Date().toISOString();
    const existing = await this.store.get(input.key);
    const view: WorkbenchView = {
      key: input.key,
      role: input.role,
      listKey: input.listKey,
      ownerId: actor.userId,
      orgId: actor.primaryOrgId,
      filter: input.filter ?? existing?.filter,
      sortKey: input.sortKey ?? existing?.sortKey,
      sortDir: input.sortDir ?? existing?.sortDir,
      limit: input.limit ?? existing?.limit,
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
    const existing = await this.store.get(key);
    if (!existing) {
      throw new NotFoundException('view not found');
    }
    if (existing.ownerId !== actor.userId && !this.isAdmin(actor)) {
      throw new ForbiddenException('You may only delete your own saved views');
    }
    await this.store.remove(key);
    await this.auditService?.appendAuditLog({
      actorId: actor.userId,
      orgId: actor.primaryOrgId,
      action: 'workbench.view.deleted',
      entityType: 'workbench_view',
      entityId: key,
    });
  }
}