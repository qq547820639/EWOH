import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RetrospectiveService } from './retrospective.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';
import type { RetrospectiveLesson } from '@shared/retrospective';

/**
 * 复盘/运行记忆 API（standalone_075，DR-3）。
 *
 *  - POST /api/retrospective/from-plan        从调度方案组装复盘（六段 + AI 总结）
 *  - GET  /api/retrospective                  列表（?scope=&status=&limit=）
 *  - GET  /api/retrospective/:retrospectiveId 单条
 *  - POST /api/retrospective/:retrospectiveId/publish    发布（draft → published）
 *  - PATCH /api/retrospective/:retrospectiveId/lessons   人工修订经验条目
 */
@Controller('api/retrospective')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class RetrospectiveController {
  constructor(private readonly retrospectiveService: RetrospectiveService) {}

  @Post('from-plan')
  fromPlan(
    @Body() body: { planId?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    if (!body?.planId?.trim()) {
      throw new BadRequestException('planId 必填');
    }
    return this.retrospectiveService.assembleFromPlan(body.planId.trim(), request.userContext);
  }

  @Get()
  list(
    @Query('scope') scope: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.retrospectiveService.list(request.userContext, {
      scope,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':retrospectiveId')
  get(
    @Param('retrospectiveId') retrospectiveId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.retrospectiveService.get(retrospectiveId, request.userContext);
  }

  @Post(':retrospectiveId/publish')
  publish(
    @Param('retrospectiveId') retrospectiveId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.retrospectiveService.publish(retrospectiveId, request.userContext);
  }

  @Post(':retrospectiveId/lessons')
  updateLessons(
    @Param('retrospectiveId') retrospectiveId: string,
    @Body() body: { lessons?: RetrospectiveLesson[] },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.retrospectiveService.updateLessons(
      retrospectiveId,
      body?.lessons ?? [],
      request.userContext,
    );
  }
}
