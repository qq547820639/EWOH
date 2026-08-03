import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSpatialEntity, ewohTopology } from '@server/database/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { SpatialEntity, Topology, SpatialHierarchyNode } from '@shared/api.interface';

@Injectable()
export class SpatialService {
  private readonly logger = new Logger(SpatialService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async getEntities(filters?: { type?: string; parentId?: string }): Promise<SpatialEntity[]> {
    try {
      const conditions = [];
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
      this.logger.error('getEntities 失败', error);
      throw error;
    }
  }

  async getEntity(entityId: string): Promise<SpatialEntity | null> {
    try {
      const rows = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(eq(ewohSpatialEntity.entityId, entityId))
        .limit(1);
      if (rows.length === 0) return null;
      return this.mapEntity(rows[0]);
    } catch (error) {
      this.logger.error(`getEntity 失败 entityId=${entityId}`, error);
      throw error;
    }
  }

  async getTopology(): Promise<Topology[]> {
    try {
      const rows = await this.db.select().from(ewohTopology);
      return rows.map((r) => ({
        id: r.id,
        fromEntity: r.fromEntity,
        toEntity: r.toEntity,
        relation: r.relation ?? 'adjacent',
        distance: r.distance ?? 0,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (error) {
      this.logger.error('getTopology 失败', error);
      throw error;
    }
  }

  async getHierarchy(): Promise<SpatialHierarchyNode[]> {
    try {
      const rows = await this.db.select().from(ewohSpatialEntity);
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
      this.logger.error('getHierarchy 失败', error);
      throw error;
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
