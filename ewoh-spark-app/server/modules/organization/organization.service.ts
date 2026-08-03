import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  ewohOrganization,
  ewohPersonnel,
  ewohDeviceBinding,
} from '@server/database/schema';
import { isValidUuid } from '@server/common/uuid';
import { AuditService } from '../shared/audit.service';

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
    const [row] = await this.db
      .insert(ewohOrganization)
      .values({
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

  async listPersonnel(query: { keyword?: string; orgId?: string; status?: string }) {
    const conditions = [];
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
    if (query.orgId) {
      conditions.push(eq(ewohPersonnel.orgId, query.orgId));
    }
    if (query.status) {
      conditions.push(eq(ewohPersonnel.status, query.status));
    }
    return this.db
      .select()
      .from(ewohPersonnel)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(ewohPersonnel.createdAt));
  }

  async getPersonnel(id: string, includeSensitive = false) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    const [row] = await this.db
      .select()
      .from(ewohPersonnel)
      .where(eq(ewohPersonnel.id, id));
    if (!row) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    if (!includeSensitive) {
      const risk = coarseHealthRisk(row.currentLoad);
      return { ...row, currentLoad: undefined, healthStatus: undefined, riskLevel: risk };
    }
    return row;
  }

  async createPersonnel(body: CreatePersonnelDto) {
    if (!body.name?.trim() || !body.employeeNo?.trim()) {
      throw new BadRequestException('name and employeeNo are required');
    }
    const [row] = await this.db
      .insert(ewohPersonnel)
      .values({
        name: body.name.trim(),
        employeeNo: body.employeeNo.trim(),
        orgId: body.orgId ?? null,
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

  async updatePersonnel(id: string, body: Partial<CreatePersonnelDto>) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Personnel ${id} not found`);
    }
    const [row] = await this.db
      .update(ewohPersonnel)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.employeeNo !== undefined ? { employeeNo: body.employeeNo.trim() } : {}),
        ...(body.orgId !== undefined ? { orgId: body.orgId } : {}),
        ...(body.teamName !== undefined ? { teamName: body.teamName } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.skills !== undefined ? { skills: body.skills } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      })
      .where(eq(ewohPersonnel.id, id))
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

  async getPersonnelBindings(personnelId: string) {
    if (!isValidUuid(personnelId)) {
      throw new NotFoundException(`Personnel ${personnelId} not found`);
    }
    return this.db
      .select()
      .from(ewohDeviceBinding)
      .where(
        or(
          eq(ewohDeviceBinding.targetId, personnelId),
          eq(ewohDeviceBinding.operatorId, personnelId),
        ),
      )
      .orderBy(desc(ewohDeviceBinding.startTime));
  }
}
