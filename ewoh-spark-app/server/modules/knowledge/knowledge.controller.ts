import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import {
  KnowledgeService,
  type RegisterKnowledgeEntryInput,
  type RetrieveKnowledgeFilters,
} from './knowledge.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Knowledge 契约 API（ADR-018 Amendment 1 / NO-07b）。
 *
 *  - POST /api/knowledge/entries               注册知识条目（契约 fail-closed）
 *  - GET  /api/knowledge/entries               租户检索阶梯（共享层 ∪ 本租户层）
 *  - GET  /api/knowledge/entries/:entryId      单条目（同阶梯；越界返回 404 语义）
 *  - POST /api/knowledge/entries/:entryId/transition  状态转移（draft→verified 需 verifiedBy）
 *  - GET  /api/knowledge/shared                跨租户共享目录（仅 global/industry）
 *
 * 所有读写带租户上下文（userContext.primaryOrgId）+ DB 层 RLS
 * （standalone_039 knowledge_entry_service_all）双保险。
 */
@Controller('api/knowledge')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post('entries')
  register(
    @Body() body: RegisterKnowledgeEntryInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.knowledgeService.registerEntry(body, this.currentOrgId(request));
  }

  @Get('entries')
  list(
    @Query('kind') kind: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    const filters: RetrieveKnowledgeFilters = { kind, scope, status };
    return this.knowledgeService.retrieveEntries(this.currentOrgId(request), filters);
  }

  @Get('shared')
  listShared(
    @Query('kind') kind: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('status') status: string | undefined,
  ) {
    const filters: RetrieveKnowledgeFilters = { kind, scope, status };
    return this.knowledgeService.retrieveSharedEntries(filters);
  }

  @Get('entries/:entryId')
  async get(
    @Param('entryId') entryId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    const entry = await this.knowledgeService.getEntry(this.currentOrgId(request), entryId);
    if (!entry) {
      throw new BadRequestException('knowledge_entry_not_found（不存在或越界，五层 scope 阶梯）');
    }
    return entry;
  }

  @Post('entries/:entryId/transition')
  transition(
    @Param('entryId') entryId: string,
    @Body() body: { to: string; verifiedBy?: string | null },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.to) {
      throw new BadRequestException('to 必填（draft→verified/superseded；verified→superseded）');
    }
    return this.knowledgeService.transitionStatus(
      this.currentOrgId(request),
      entryId,
      { to: body.to, verifiedBy: body.verifiedBy },
    );
  }

  /** 租户上下文（AccessTokenGuard 注入；缺失 fail-closed 抛错）。 */
  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: knowledge operations require tenant context');
    }
    return orgId;
  }
}
