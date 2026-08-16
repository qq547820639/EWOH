import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException } from '@nestjs/common';
import {
  InferenceResultService,
  type RecordInferenceResultInput,
} from './inference.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * InferenceResult 契约 API（ADR-019 / NO-08a）。
 *
 *  - POST /api/inference/results               记录规范推理结果（契约 fail-closed）
 *  - GET  /api/inference/results               台账列表（租户作用域，level/subject 过滤）
 *  - GET  /api/inference/results/:inferenceId  单条（越界 400）
 *
 * 所有读写带租户上下文（userContext.primaryOrgId）+ DB 层 RLS
 * （standalone_040 inference_result_org_isolation）双保险。
 */
@Controller('api/inference')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class InferenceController {
  constructor(private readonly inferenceService: InferenceResultService) {}

  @Post('results')
  record(
    @Body() body: RecordInferenceResultInput,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.inferenceService.recordInferenceResult(body, this.currentOrgId(request));
  }

  @Get('results')
  list(
    @Query('level') level: string | undefined,
    @Query('subjectId') subjectId: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.inferenceService.listInferenceResults(this.currentOrgId(request), {
      level,
      subjectId,
    });
  }

  @Get('results/:inferenceId')
  async get(
    @Param('inferenceId') inferenceId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    const result = await this.inferenceService.getInferenceResult(
      this.currentOrgId(request),
      inferenceId,
    );
    if (!result) {
      throw new BadRequestException('inference_result_not_found（不存在或非本租户）');
    }
    return result;
  }

  /** 租户上下文（AccessTokenGuard 注入；缺失 fail-closed 抛错）。 */
  private currentOrgId(request: { userContext?: OrgContext }): string {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org context missing: inference operations require tenant context');
    }
    return orgId;
  }
}
