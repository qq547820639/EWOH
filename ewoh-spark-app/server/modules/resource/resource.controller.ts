import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { ResourceService } from './resource.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * NEST-617（2026-08-17 审计整改）：补 @Roles（原先任何认证用户可创建
 * 预占/发放/释放）。角色集与 route-role.policy FALLBACK 表一致。
 */
@Controller('api/resource/preorders')
@Roles('global_admin', 'dispatcher')
export class ResourceController {
  constructor(private readonly resourceService: ResourceService) {}

  @Post()
  create(
    @Body() body: { resourceId: string; quantity: number },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.resourceService.createPreorder(
      body.resourceId,
      body.quantity,
      request.userContext,
    );
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.resourceService.getPreorder(id);
  }

  @Post(':id/issue')
  issue(
    @Param('id') id: string,
    @Body() body: { quantity: number },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.resourceService.issue(id, body.quantity, request.userContext);
  }

  @Post(':id/release')
  release(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    if (action !== 'release') {
      return this.resourceService.getPreorder(id);
    }
    return this.resourceService.release(id, request.userContext);
  }
}
