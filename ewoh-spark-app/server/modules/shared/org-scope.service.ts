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
  /**
   * NEST-511（2026-08-17）：可选的批量加载——一次查询取回全量 org 行，
   * 供 resolveOrgScope 在内存中做 BFS（替代逐节点 loadChildren 的 N+1 查询：
   * 宽层级下原实现 = 节点数次往返）。测试 fake 可不实现（回退逐节点路径）。
   */
  loadAll?(): Promise<OrgNode[]>;
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

/** 组织层级出现环：继承事实不可信，调用方必须 fail-closed。 */
export class OrgScopeHierarchyCycleError extends Error {
  readonly cyclePath: string[];

  constructor(cyclePath: string[]) {
    super(`Organization hierarchy cycle detected: ${cyclePath.join(' -> ')}`);
    this.name = 'OrgScopeHierarchyCycleError';
    this.cyclePath = cyclePath;
  }
}

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
  /**
   * NEST-520 文档化（2026-08-17）：cache 为进程内 Map，多实例部署下失效不跨
   * 实例同步——各实例在 TTL（ORG_SCOPE_CACHE_TTL_MS，默认 5min）内可能返回
   * 过期 org 树（最终一致）。org 写路径调用 invalidate() 仅本实例生效；
   * 如需强一致，缩短 TTL 或迁移共享缓存（Redis）另行立项。
   */
  private readonly cache = new Map<string, { resolution: OrgScopeResolution; expiresAt: number }>();
  private readonly invalidationListeners = new Set<OrgInvalidationListener>();
  private readonly provider: OrgHierarchyProvider;

  constructor(
    @Optional() injectedProvider?: OrgHierarchyProvider,
    @Optional() @Inject(DRIZZLE_DATABASE) db?: PostgresJsDatabase,
  ) {
    if (!injectedProvider && !db) {
      // NEST-513：缺 DB 或显式 provider 时，接受任意 orgId 的默认实现会让
      // 租户层级校验静默失效。构造期直接失败，避免请求期扩大授权范围。
      throw new Error('OrgScopeService requires an injected provider or database');
    }
    this.provider = injectedProvider ?? new DatabaseOrgHierarchyProvider(db!);
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

    // NEST-511（2026-08-17）：provider 支持批量加载时用单查询 + 内存 BFS，
    // 消除宽层级下的逐节点 N+1 查询；否则回退原逐节点路径（fake provider 兼容）。
    if (typeof this.provider.loadAll === 'function') {
      const allNodes = await this.provider.loadAll();
      const byParent = new Map<string, OrgNode[]>();
      for (const node of allNodes) {
        if (node.parentId == null) continue;
        const bucket = byParent.get(node.parentId);
        if (bucket) {
          bucket.push(node);
        } else {
          byParent.set(node.parentId, [node]);
        }
      }
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const child of byParent.get(current) ?? []) {
          if (!visited.has(child.id)) {
            visited.add(child.id);
            descendants.push(child);
            queue.push(child.id);
          }
        }
      }
    } else {
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
    path: string[] = [],
  ): Promise<{ config: Record<string, unknown>; ancestorIds: string[] }> {
    if (seen.has(orgId)) {
      const cycleStart = path.indexOf(orgId);
      throw new OrgScopeHierarchyCycleError([
        ...path.slice(cycleStart),
        orgId,
      ]);
    }
    seen.add(orgId);
    const pathToOrg = [...path, orgId];

    const org = await this.loadOrgOrThrow(orgId);
    const own = org.config ?? {};
    if (!org.parentId) {
      return { config: { ...own }, ancestorIds: [] };
    }

    const parent = await this.loadEffectiveConfig(org.parentId, seen, pathToOrg);
    return {
      config: { ...parent.config, ...own },
      ancestorIds: [...parent.ancestorIds, org.parentId],
    };
  }
}
