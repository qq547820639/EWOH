import { Inject, Injectable, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';

export const ORG_SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface OrgNode {
  id: string;
  parentId: string | null;
  config?: Record<string, unknown> | null;
}

export interface OrgHierarchyProvider {
  loadOrg(orgId: string): Promise<OrgNode | null>;
  loadChildren(parentId: string): Promise<OrgNode[]>;
}

export interface OrgScopeResolution {
  orgId: string;
  orgIds: string[];
  ancestorIds: string[];
  inheritedConfig: Record<string, unknown>;
  resolvedAt: Date;
  cached: boolean;
}

export type OrgInvalidationListener = (orgId: string | null) => void;

const DEFAULT_PROVIDER: OrgHierarchyProvider = {
  async loadOrg(orgId: string): Promise<OrgNode> {
    return { id: orgId, parentId: null, config: {} };
  },
  async loadChildren(): Promise<OrgNode[]> {
    return [];
  },
};

/**
 * DB-backed org hierarchy provider backed by ewoh_organization.
 *
 * ewoh_organization.org_id is the tenant id carried on data rows, while
 * parent_id points at the parent organization row id. The provider accepts
 * both id conventions so single-org and seeded multi-level orgs resolve the
 * same way.
 */
export class DatabaseOrgHierarchyProvider implements OrgHierarchyProvider {
  constructor(private readonly db: PostgresJsDatabase) {}

  async loadOrg(orgId: string): Promise<OrgNode | null> {
    const rows = await this.db.execute(
      sql`
        select * from ewoh_find_org(${orgId})
      `,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.org_id ?? row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      config: {},
    };
  }

  async loadChildren(parentId: string): Promise<OrgNode[]> {
    const rows = await this.db.execute(
      sql`
        select * from ewoh_find_org_children(${parentId})
      `,
    );
    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: String(record.org_id ?? record.id),
        parentId: record.parent_id ? String(record.parent_id) : null,
        config: {},
      };
    });
  }
}

@Injectable()
export class OrgScopeService {
  private readonly cache = new Map<string, { resolution: OrgScopeResolution; expiresAt: number }>();
  private readonly invalidationListeners = new Set<OrgInvalidationListener>();
  private readonly provider: OrgHierarchyProvider;

  constructor(
    @Optional() injectedProvider?: OrgHierarchyProvider,
    @Optional() @Inject(DRIZZLE_DATABASE) db?: PostgresJsDatabase,
  ) {
    this.provider =
      injectedProvider ?? (db ? new DatabaseOrgHierarchyProvider(db) : DEFAULT_PROVIDER);
  }

  async resolveOrgScope(orgId: string): Promise<OrgScopeResolution> {
    const cached = this.cache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) {
      cached.resolution.cached = true;
      return cached.resolution;
    }

    const root = await this.loadOrgOrThrow(orgId);
    const descendants: OrgNode[] = [];
    const visited = new Set<string>([root.id]);
    const queue = [root.id];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.provider.loadChildren(current);
      for (const child of children) {
        if (!visited.has(child.id)) {
          visited.add(child.id);
          descendants.push(child);
          queue.push(child.id);
        }
      }
    }

    const effective = await this.loadEffectiveConfig(root.id, new Set<string>());
    const resolution: OrgScopeResolution = {
      orgId,
      orgIds: [...new Set([root.id, ...descendants.map((node) => node.id)])],
      ancestorIds: effective.ancestorIds,
      inheritedConfig: effective.config,
      resolvedAt: new Date(),
      cached: false,
    };

    this.cache.set(orgId, {
      resolution,
      expiresAt: Date.now() + ORG_SCOPE_CACHE_TTL_MS,
    });
    return resolution;
  }

  invalidate(orgId?: string): void {
    if (orgId) {
      for (const [key, entry] of this.cache) {
        if (
          key === orgId ||
          entry.resolution.orgIds.includes(orgId) ||
          entry.resolution.ancestorIds.includes(orgId)
        ) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }

    for (const listener of this.invalidationListeners) {
      listener(orgId ?? null);
    }
  }

  onInvalidate(listener: OrgInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async loadOrgOrThrow(orgId: string): Promise<OrgNode> {
    const org = await this.provider.loadOrg(orgId);
    if (!org) {
      throw new Error(`Org not found: ${orgId}`);
    }
    return org;
  }

  private async loadEffectiveConfig(
    orgId: string,
    seen: Set<string>,
  ): Promise<{ config: Record<string, unknown>; ancestorIds: string[] }> {
    if (seen.has(orgId)) {
      return { config: {}, ancestorIds: [] };
    }
    seen.add(orgId);

    const org = await this.loadOrgOrThrow(orgId);
    const own = org.config ?? {};
    if (!org.parentId) {
      return { config: { ...own }, ancestorIds: [] };
    }

    const parent = await this.loadEffectiveConfig(org.parentId, seen);
    return {
      config: { ...parent.config, ...own },
      ancestorIds: [...parent.ancestorIds, org.parentId],
    };
  }
}
