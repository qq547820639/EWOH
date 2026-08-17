import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
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
  /**
   * NO-08b（ADR-013）：输入版本（特征/数据版本）。Model Registry 无独立列，
   * 存入 cardJson.inputVersion（Model Card 本就是数据/特征/模型/阈值版本的
   * 治理载体，与边缘 model_card.py 对齐）。
   */
  inputVersion?: string | null;
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

  /** NEST-411：org 上下文强制（缺失 401）；global_admin 跨租户放行。 */
  private orgScope(actor?: OrgContext): { orgId?: string } {
    if (actor?.isGlobalAdmin) return {};
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：模型注册表读写必须带租户上下文',
      );
    }
    return { orgId };
  }

  async listModels(actor?: OrgContext) {
    const { orgId } = this.orgScope(actor);
    return this.db
      .select()
      .from(ewohModelRegistry)
      .where(orgId ? eq(ewohModelRegistry.orgId, orgId) : undefined)
      .orderBy(desc(ewohModelRegistry.createdAt));
  }

  async getModel(id: string, actor?: OrgContext) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    const { orgId } = this.orgScope(actor);
    const [row] = await this.db
      .select()
      .from(ewohModelRegistry)
      .where(
        orgId
          ? and(eq(ewohModelRegistry.id, id), eq(ewohModelRegistry.orgId, orgId))
          : eq(ewohModelRegistry.id, id),
      );
    if (!row) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    return row;
  }

  async registerModel(body: RegisterModelDto, actor?: OrgContext) {
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
    // NEST-411：写入显式携带 orgId（global_admin 归属其 primaryOrgId）。
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：模型注册必须带租户上下文',
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
        orgId,
        // NO-08b（ADR-013）：inputVersion 对齐 InferenceResult 契约元数据
        //（无独立列，落 cardJson.inputVersion；缺省不伪造）。
        cardJson: {
          ...(body.cardJson ?? {}),
          ...(body.inputVersion?.trim()
            ? { inputVersion: body.inputVersion.trim() }
            : {}),
        },
      })
      .returning();
    return row;
  }

  async transitionStatus(id: string, action: string, actor?: OrgContext) {
    const current = await this.getModel(id, actor);
    const status = nextModelStatus(current.status ?? 'candidate', action);
    if (status === current.status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${current.status}`,
      );
    }
    const before = current.status ?? 'candidate';
    // R2-SNZ-015：写谓词补 orgId 列（与 quality/workorder 对齐的纵深防御；
    // global_admin 放行，与读侧 org 谓词语义一致）。
    const transitionOrgCond = actor?.isGlobalAdmin
      ? undefined
      : eq(ewohModelRegistry.orgId, actor?.primaryOrgId?.trim() ?? '__none__');
    const [row] = await this.db
      .update(ewohModelRegistry)
      .set({ status })
      .where(
        transitionOrgCond
          ? and(
              eq(ewohModelRegistry.id, id),
              eq(ewohModelRegistry.status, before),
              transitionOrgCond,
            )
          : and(eq(ewohModelRegistry.id, id), eq(ewohModelRegistry.status, before)),
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
