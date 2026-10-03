import { BadRequestException, Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSpatialEntity, ewohTopology } from '@server/database/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { isValidSpatialKind } from '@shared/location';
import { DomainContractError } from '@shared/risk';
import type { SpatialEntity, Topology, SpatialHierarchyNode } from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { rethrowWithLog } from '../shared/rethrow-with-log';

@Injectable()
export class SpatialService {
  private readonly logger = new Logger(SpatialService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * NEST-622（2026-08-17 审计整改）：spatial 查询带 org 谓词
   * （global_admin 显式放行，与 RLS 例外路径一致）。
   */
  private orgCondition(actor?: OrgContext) {
    if (actor?.isGlobalAdmin) return undefined;
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: spatial queries require tenant context',
      );
    }
    return eq(ewohSpatialEntity.orgId, orgId);
  }

  async getEntities(
    filters?: { type?: string; parentId?: string },
    actor?: OrgContext,
  ): Promise<SpatialEntity[]> {
    try {
      const conditions = [];
      const orgCond = this.orgCondition(actor);
      if (orgCond) conditions.push(orgCond);
      if (filters?.type) {
        conditions.push(eq(ewohSpatialEntity.entityType, filters.type));
      }
      if (filters?.parentId !== undefined) {
        if (filters.parentId === '') {
          conditions.push(isNull(ewohSpatialEntity.parentId));
        } else {
          conditions.push(eq(ewohSpatialEntity.parentId, filters.parentId));
        }
      }

      const orderExpr = sql<number>`case ${ewohSpatialEntity.entityType}
        when 'factory' then 1
        when 'workshop' then 2
        when 'production_line' then 3
        when 'zone' then 4
        when 'workstation' then 5
        when 'device' then 6
        when 'person' then 7
        when 'camera' then 8
        when 'uwb_station' then 9
        when 'route' then 10
        when 'restricted_zone' then 11
        else 99
      end`;

      const rows = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderExpr, ewohSpatialEntity.name);

      return rows.map((r) => this.mapEntity(r));
    } catch (error) {
      rethrowWithLog(this.logger, 'getEntities 失败', error);
    }
  }

  async getEntity(entityId: string, actor?: OrgContext): Promise<SpatialEntity | null> {
    try {
      const orgCond = this.orgCondition(actor);
      const rows = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          orgCond
            ? and(eq(ewohSpatialEntity.entityId, entityId), orgCond)
            : eq(ewohSpatialEntity.entityId, entityId),
        )
        .limit(1);
      if (rows.length === 0) return null;
      return this.mapEntity(rows[0]);
    } catch (error) {
      rethrowWithLog(this.logger, `getEntity 失败 entityId=${entityId}`, error);
    }
  }

  async getTopology(actor?: OrgContext): Promise<Topology[]> {
    try {
      const orgCond = this.orgCondition(actor);
      const rows = await this.db
        .select()
        .from(ewohTopology)
        .where(orgCond ? and(eq(ewohTopology.orgId, actor!.primaryOrgId!)) : undefined);
      return rows.map((r) => ({
        id: r.id,
        fromEntity: r.fromEntity,
        toEntity: r.toEntity,
        relation: r.relation ?? 'adjacent',
        distance: r.distance ?? 0,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (error) {
      rethrowWithLog(this.logger, 'getTopology 失败', error);
    }
  }

  async getHierarchy(actor?: OrgContext): Promise<SpatialHierarchyNode[]> {
    try {
      const orgCond = this.orgCondition(actor);
      const rows = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(orgCond);
      const entities = rows.map((r) => this.mapEntity(r));

      // 按 entityId 索引
      const nodeMap = new Map<string, SpatialHierarchyNode>();
      for (const entity of entities) {
        nodeMap.set(entity.entityId, { entity, children: [] });
      }

      const roots: SpatialHierarchyNode[] = [];
      // 防止循环引用：已挂载到某个父节点下的节点不再重复加入 roots
      const mounted = new Set<string>();

      for (const entity of entities) {
        const node = nodeMap.get(entity.entityId)!;
        const parentId = entity.parentId;
        // parentId 为 null 或空字符串视为根节点
        if (!parentId || parentId === '') {
          roots.push(node);
          mounted.add(entity.entityId);
          continue;
        }

        const parent = nodeMap.get(parentId);
        if (parent && !this.wouldCreateCycle(nodeMap, entity.entityId, parentId)) {
          parent.children.push(node);
          mounted.add(entity.entityId);
        } else {
          // 父节点不存在，或挂载会形成环，降级为根节点
          roots.push(node);
          mounted.add(entity.entityId);
        }
      }

      return roots;
    } catch (error) {
      rethrowWithLog(this.logger, 'getHierarchy 失败', error);
    }
  }

  /**
   * 检测把 childId 挂到 parentId 下是否会形成环。
   * 沿 parentId 向上追溯祖先链，若遇到 childId 则会成环。
   */
  private wouldCreateCycle(
    nodeMap: Map<string, SpatialHierarchyNode>,
    childId: string,
    parentId: string,
  ): boolean {
    const visited = new Set<string>();
    let current: string | null = parentId;
    while (current) {
      if (current === childId) return true;
      if (visited.has(current)) return true; // 祖先链本身已存在环，防御性退出
      visited.add(current);
      const node = nodeMap.get(current);
      current = node?.entity?.parentId ?? null;
      if (current === null || current === '') break;
    }
    return false;
  }

  private mapEntity(r: typeof ewohSpatialEntity.$inferSelect): SpatialEntity {
    // ADR-007：entityType 必须是 Canonical Location 注册表内类型；脏值 fail-closed
    // 抛错（ingest 边界已拦截未知类型，此处防御存量脏行）。
    if (!isValidSpatialKind(r.entityType)) {
      throw new DomainContractError(
        'unknown_spatial_kind',
        `ewoh_spatial_entity ${r.entityId} entity_type 不在注册表: ${JSON.stringify(r.entityType)}`,
      );
    }
    return {
      id: r.id,
      entityId: r.entityId,
      entityType: r.entityType,
      parentId: r.parentId,
      name: r.name,
      x: r.x ?? 0,
      y: r.y ?? 0,
      yaw: r.yaw ?? 0,
      bboxW: r.bboxW ?? 0,
      bboxH: r.bboxH ?? 0,
      status: r.status ?? 'active',
      sourceType: r.sourceType ?? 'seed',
      confidence: r.confidence ?? 1.0,
      version: r.version ?? 1,
      extra: (r.extra as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
