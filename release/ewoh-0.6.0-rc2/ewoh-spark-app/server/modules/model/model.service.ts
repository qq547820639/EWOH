import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohModelRegistry } from '@server/database/schema';
import { isValidUuid } from '@server/common/uuid';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface RegisterModelDto {
  modelId: string;
  modelName: string;
  version: string;
  type: string;
  cardJson?: Record<string, unknown>;
}

export function nextModelStatus(current: string, action: string): string {
  switch (action) {
    case 'submit_review':
      return current === 'candidate' ? 'reviewing' : current;
    case 'approve_review':
      return current === 'reviewing' ? 'shadow' : current;
    case 'activate':
      return current === 'shadow' || current === 'active' ? 'active' : current;
    case 'retire':
      return current === 'active' ? 'retired' : current;
    default:
      return current;
  }
}

@Injectable()
export class ModelService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async listModels() {
    return this.db
      .select()
      .from(ewohModelRegistry)
      .orderBy(desc(ewohModelRegistry.createdAt));
  }

  async getModel(id: string) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    const [row] = await this.db
      .select()
      .from(ewohModelRegistry)
      .where(eq(ewohModelRegistry.id, id));
    if (!row) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    return row;
  }

  async registerModel(body: RegisterModelDto) {
    if (
      !body.modelId?.trim() ||
      !body.modelName?.trim() ||
      !body.version?.trim() ||
      !body.type?.trim()
    ) {
      throw new BadRequestException(
        'modelId, modelName, version and type are required',
      );
    }
    const [row] = await this.db
      .insert(ewohModelRegistry)
      .values({
        modelId: body.modelId.trim(),
        modelName: body.modelName.trim(),
        version: body.version.trim(),
        type: body.type.trim(),
        status: 'candidate',
        cardJson: body.cardJson ?? null,
      })
      .returning();
    return row;
  }

  async transitionStatus(id: string, action: string, actor?: OrgContext) {
    const current = await this.getModel(id);
    const status = nextModelStatus(current.status ?? 'candidate', action);
    if (status === current.status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${current.status}`,
      );
    }
    const before = current.status ?? 'candidate';
    const [row] = await this.db
      .update(ewohModelRegistry)
      .set({ status })
      .where(
        and(eq(ewohModelRegistry.id, id), eq(ewohModelRegistry.status, before)),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `model.${action}`,
      entityType: 'model',
      entityId: row.id,
      before: { status: before },
      after: { status: row.status },
    });
    return row;
  }
}
