import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import {
  ewohOrganization,
  ewohPersonnel,
  ewohDeviceBinding,
} from '@server/database/schema';
import { isValidUuid } from '@server/common/uuid';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface OrgRecord {
  id: string;
  name: string;
  orgType: string;
  parentId: string | null;
  status: string | null;
  description: string | null;
}

export interface OrgTreeNode extends OrgRecord {
  children: OrgTreeNode[];
}

export interface CreateOrganizationDto {
  name: string;
  orgType: string;
  parentId?: string;
  description?: string;
}

export interface CreatePersonnelDto {
  name: string;
  employeeNo: string;
  orgId?: string;
  teamName?: string;
  position?: string;
  skills?: string[];
  status?: string;
}

export function buildOrgTree(records: OrgRecord[]): OrgTreeNode[] {
  const byId = new Map<string, OrgTreeNode>();
  for (const record of records) {
    byId.set(record.id, { ...record, children: [] });
  }
  const roots: OrgTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export type HealthRiskLevel = 'low' | 'medium' | 'high';

export function coarseHealthRisk(currentLoad: unknown): HealthRiskLevel {
  if (!currentLoad || typeof currentLoad !== 'object') {
    return 'low';
  }
  const load = currentLoad as { loadLevel?: number; fatigueLevel?: number };
  const loadLevel = Number(load.loadLevel ?? 0);
  const fatigueLevel = Number(load.fatigueLevel ?? 0);
  if (loadLevel >= 0.8 || fatigueLevel >= 0.8) {
    return 'high';
  }
  if (loadLevel >= 0.5 || fatigueLevel >= 0.5) {
    return 'medium';
  }
  return 'low';
}

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private async requestActorContext(): Promise<{ actorId: string; orgId: string | null }> {
    try {
      const [row] = await this.db.execute(
        sql`
          select current_setting('app.user_id', true) as user_id,
                 current_setting('app.current_org_id', true) as org_id
        `,
      );
      const record = row as Record<string, unknown>;
      return {
        actorId: record.user_id ? String(record.user_id) : 'system',
        orgId: record.org_id ? String(record.org_id) : null,
      };
    } catch {
      return { actorId: 'system', orgId: null };
    }
  }

  private async recordAudit(entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    if (!this.auditService) {
      return;
    }
    const context = await this.requestActorContext();
    await this.auditService.appendAuditLog({
      actorId: context.actorId,
      orgId: context.orgId ?? '',
      ...entry,
    });
  }

  async listOrganizations() {
    return this.db
      .select()
      .from(ewohOrganization)
      .orderBy(asc(ewohOrganization.name));
  }

  async getOrganizationTree() {
    const rows = await this.listOrganizations();
    return buildOrgTree(rows.map((row) => ({
      id: row.id,
      name: row.name,
      orgType: row.orgType,
      parentId: row.parentId,
      status: row.status,
      description: row.description,
    })));
  }

  async createOrganization(body: CreateOrganizationDto) {
    if (!body.name?.trim() || !body.orgType?.trim()) {
      throw new BadRequestException('name and orgType are required');
    }
    // NO-13aa（ADR-075 续）：org 行归属 = 自身 id（应用侧确定性 UUID，
    // 001 ewoh_org_visible RLS 下组织行对自身/全局管理员可见，§3 单一事实源）。
    const newOrgId = randomUUID();
    const [row] = await this.db
      .insert(ewohOrganization)
      .values({
        id: newOrgId,
        orgId: newOrgId,
        name: body.name.trim(),
        orgType: body.orgType.trim(),
        parentId: body.parentId ?? null,
        description: body.description ?? null,
      })
      .returning();
    await this.recordAudit({
      action: 'organization.create',
      entityType: 'organization',
      entityId: row.id,
      after: {
        name: row.name,
        orgType: row.orgType,
        parentId: row.parentId,
        description: row.description,
      },
    });
    return row;
  }

  async updateOrganization(id: string, body: Partial<CreateOrganizationDto>) {
    const [row] = await this.db
      .update(ewohOrganization)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.orgType !== undefined ? { orgType: body.orgType.trim() } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      })
      .where(eq(ewohOrganization.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException(`Organization ${id} not found`);
    }
    await this.recordAudit({
      action: 'organization.update',
      entityType: 'organization',
      entityId: row.id,
      after: {
        name: row.name,
        orgType: row.orgType,
        parentId: row.parentId,
        description: row.description,
      },
    });
    return row;
  }

  /**
   * NEST-637（2026-08-17 审计整改）：人员列表分页（原先 select 全表仅
   * orderBy，无界）。limit 缺省 200、上限 500；offset 缺省 0。
   * 返回保持数组形状（客户端契约兼容），大表翻页经 limit/offset。
   */
  /**
   * R2-SNZ-011：personnel 面租户谓词——非 global 请求限定 actor 租户
   * （缺租户 fail-closed 400）；显式 orgId 参数仅允许 ∈ accessibleOrgIds
   * （global_admin 放行任意，原先 workshop_lead 可枚举/篡改任意组织人员）。
   */
  private personnelOrgCondition(actor?: OrgContext, requestedOrgId?: string): SQL | undefined {
    const requested = requestedOrgId?.trim();
    if (actor?.isGlobalAdmin) {
      return requested ? (eq(ewohPersonnel.orgId, requested) as SQL) : undefined;
    }
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: personnel operations require tenant context',
      );
    }
    if (requested && requested !== orgId) {
      const accessible = (actor?.accessibleOrgIds ?? []).map((o) => o.trim());
      if (!accessible.includes(requested)) {
        throw new BadRequestException(`orgId ${requested} not accessible`);
      }
      return eq(ewohPersonnel.orgId, requested) as SQL;
    }
    return eq(ewohPersonnel.orgId, orgId) as SQL;
  }

  async listPersonnel(
    query: {
      keyword?: string;
      orgId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
    actor?: OrgContext,
  ) {
    const conditions = [];
    // R2-SNZ-011：租户谓词优先于用户 orgId 参数（后者仅做 accessible 收窄）。
    conditions.push(this.personnelOrgCondition(actor, query.orgId));
    if (query.keyword) {
      const kw = `%${query.keyword}%`;
      conditions.push(
        or(
          ilike(ewohPersonnel.name, kw),
          ilike(ewohPersonnel.employeeNo, kw),
          ilike(ewohPersonnel.position, kw),
        ),
      );
    }
    if (query.status) {
      conditions.push(eq(ewohPersonnel.status, query.status));
    }
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 200)), 500);
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    return this.db
      .select()
      .from(ewohPersonnel)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(ewohPersonnel.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getPersonnel(id: string, includeSensitive = false, actor?: OrgContext) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    // R2-SNZ-011：按 id 定位同样限定租户（原先全局定位，跨租户可读）。
    const orgCond = this.personnelOrgCondition(actor);
    const [row] = await this.db
      .select()
      .from(ewohPersonnel)
      .where(orgCond ? and(eq(ewohPersonnel.id, id), orgCond) : eq(ewohPersonnel.id, id));
    if (!row) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    if (!includeSensitive) {
      const risk = coarseHealthRisk(row.currentLoad);
      return { ...row, currentLoad: undefined, healthStatus: undefined, riskLevel: risk };
    }
    return row;
  }

  async createPersonnel(body: CreatePersonnelDto, actor?: OrgContext) {
    if (!body.name?.trim() || !body.employeeNo?.trim()) {
      throw new BadRequestException('name and employeeNo are required');
    }
    // R2-SNZ-011：行归属显式化——非 global 强制 actor 租户（body.orgId 仅
    // 可指定 accessible org；global_admin 保留显式指定/缺省 primary）。
    const personnelOrgId = this.personnelOrgCondition(actor, body.orgId) == null
      ? (actor?.primaryOrgId?.trim() ?? body.orgId?.trim() ?? null)
      : (body.orgId?.trim() ?? actor?.primaryOrgId?.trim() ?? null);
    const [row] = await this.db
      .insert(ewohPersonnel)
      .values({
        name: body.name.trim(),
        employeeNo: body.employeeNo.trim(),
        orgId: personnelOrgId,
        teamName: body.teamName ?? null,
        position: body.position ?? null,
        skills: body.skills ?? [],
        status: body.status ?? 'available',
      })
      .returning();
    await this.recordAudit({
      action: 'personnel.create',
      entityType: 'personnel',
      entityId: row.id,
      after: {
        name: row.name,
        employeeNo: row.employeeNo,
        orgId: row.orgId,
        position: row.position,
        status: row.status,
      },
    });
    return row;
  }

  async updatePersonnel(id: string, body: Partial<CreatePersonnelDto>, actor?: OrgContext) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    // R2-SNZ-011：变更谓词带租户（原先按 id 全局定位可跨租户篡改）；
    // orgId 字段变更走 personnelOrgCondition 校验（仅 accessible 可选）。
    const orgCond = this.personnelOrgCondition(actor);
    if (body.orgId !== undefined) {
      this.personnelOrgCondition(actor, body.orgId ?? undefined);
    }
    const [row] = await this.db
      .update(ewohPersonnel)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.employeeNo !== undefined ? { employeeNo: body.employeeNo.trim() } : {}),
        ...(body.orgId !== undefined
          ? { orgId: body.orgId?.trim() ?? null }
          : {}),
        ...(body.teamName !== undefined ? { teamName: body.teamName } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.skills !== undefined ? { skills: body.skills } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      })
      .where(orgCond ? and(eq(ewohPersonnel.id, id), orgCond) : eq(ewohPersonnel.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    await this.recordAudit({
      action: 'personnel.update',
      entityType: 'personnel',
      entityId: row.id,
      after: {
        name: row.name,
        employeeNo: row.employeeNo,
        orgId: row.orgId,
        position: row.position,
        status: row.status,
      },
    });
    return row;
  }

  async getPersonnelBindings(personnelId: string, actor?: OrgContext) {
    if (!isValidUuid(personnelId)) {
      throw new NotFoundException(`Personnel ${personnelId} not found`);
    }
    // R2-SNZ-011：先校验人员对本调用者可见（跨租户 personnelId 404），
    // 绑定行同样限定租户（global_admin 放行）。
    await this.getPersonnel(personnelId, false, actor);
    const orgCond = actor?.isGlobalAdmin
      ? undefined
      : eq(ewohDeviceBinding.orgId, actor?.primaryOrgId?.trim() ?? '__none__');
    const bindingCond = or(
      eq(ewohDeviceBinding.targetId, personnelId),
      eq(ewohDeviceBinding.operatorId, personnelId),
    );
    return this.db
      .select()
      .from(ewohDeviceBinding)
      .where(orgCond ? and(bindingCond, orgCond) : bindingCond)
      .orderBy(desc(ewohDeviceBinding.startTime));
  }
}
