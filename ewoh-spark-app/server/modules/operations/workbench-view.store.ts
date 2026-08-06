import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ewohSavedViews } from '@server/database/schema';
import type {
  WorkbenchView,
  WorkbenchViewStore,
} from './workbench-view.service';

/**
 * PostgreSQL-persisted, org + owner scoped saved-view store.
 *
 * Durable across restarts / instances / devices (the `saved_views` table created
 * by `standalone_005_workbench_prod.sql`). Owned views are isolated by
 * `organization_id` + `owner_user_id`; `list` also returns org-shared views.
 *
 * The domain `WorkbenchView` maps onto the persisted row as follows:
 *   key/listKey/role/ownerId/orgId  → dedicated columns (name/list_key/
 *     workbench/owner_user_id/organization_id)
 *   filter/sortKey/sortDir/limit/shared → the JSON passthrough columns
 *     (filter_json / sort_json) so the schema stays stable across spec changes.
 *
 * NOTE: tenant isolation is additionally enforced by the request transaction's
 * `app.current_org_id` GUC (see OrgContextInterceptor). This store still scopes
 * every read/write by explicit `organization_id` for defense in depth.
 */

type SavedViewRow = typeof ewohSavedViews.$inferSelect;

function toDomain(row: SavedViewRow): WorkbenchView {
  const filterJson = (row.filterJson ?? {}) as {
    filter?: string;
    limit?: number;
    shared?: boolean;
  };
  const sortJson = (row.sortJson ?? {}) as {
    sortKey?: string;
    sortDir?: 'asc' | 'desc';
  };
  return {
    key: row.name,
    role: row.workbench,
    listKey: row.listKey ?? '',
    ownerId: row.ownerUserId,
    orgId: row.organizationId,
    filter: filterJson.filter,
    sortKey: sortJson.sortKey,
    sortDir: sortJson.sortDir,
    limit: filterJson.limit,
    shared: filterJson.shared ?? false,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

@Injectable()
export class PostgresWorkbenchViewStore implements WorkbenchViewStore {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async save(view: WorkbenchView): Promise<WorkbenchView> {
    const createdAt = new Date(view.createdAt ?? new Date().toISOString());
    const existing = await this.get(view.orgId, view.ownerId, view.key);

    const filterJson = {
      filter: view.filter ?? null,
      limit: view.limit ?? null,
      shared: view.shared ?? false,
    };
    const sortJson = {
      sortKey: view.sortKey ?? null,
      sortDir: view.sortDir ?? null,
    };

    if (existing) {
      await this.db
        .update(ewohSavedViews)
        .set({
          listKey: view.listKey,
          workbench: view.role,
          filterJson,
          sortJson,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(ewohSavedViews.organizationId, view.orgId),
            eq(ewohSavedViews.ownerUserId, view.ownerId),
            eq(ewohSavedViews.name, view.key),
            isNull(ewohSavedViews.deletedAt),
          ),
        );
    } else {
      await this.db.insert(ewohSavedViews).values({
        organizationId: view.orgId,
        ownerUserId: view.ownerId,
        name: view.key,
        workbench: view.role,
        listKey: view.listKey,
        schemaVersion: 1,
        filterJson,
        sortJson,
        isDefault: false,
        createdAt,
        updatedAt: new Date(),
      });
    }

    return view;
  }

  async get(
    orgId: string,
    ownerId: string,
    key: string,
  ): Promise<WorkbenchView | undefined> {
    const rows = await this.db
      .select()
      .from(ewohSavedViews)
      .where(
        and(
          eq(ewohSavedViews.organizationId, orgId),
          eq(ewohSavedViews.ownerUserId, ownerId),
          eq(ewohSavedViews.name, key),
          isNull(ewohSavedViews.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async list(ownerId: string, orgId: string): Promise<WorkbenchView[]> {
    const rows = await this.db
      .select()
      .from(ewohSavedViews)
      .where(
        and(
          eq(ewohSavedViews.organizationId, orgId),
          isNull(ewohSavedViews.deletedAt),
        ),
      )
      .orderBy(asc(ewohSavedViews.createdAt));
    return rows
      .filter(
        (row) => row.ownerUserId === ownerId || (row.filterJson as { shared?: boolean } | null)?.shared,
      )
      .map(toDomain);
  }

  async remove(orgId: string, ownerId: string, key: string): Promise<void> {
    await this.db
      .update(ewohSavedViews)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(ewohSavedViews.organizationId, orgId),
          eq(ewohSavedViews.ownerUserId, ownerId),
          eq(ewohSavedViews.name, key),
          isNull(ewohSavedViews.deletedAt),
        ),
      );
  }
}