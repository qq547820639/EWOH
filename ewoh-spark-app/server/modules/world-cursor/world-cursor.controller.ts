import { Controller, Get, Query, HttpException, HttpStatus, Req, BadRequestException } from '@nestjs/common';
import { WorldCursorService, CursorExpiredError } from './world-cursor.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * NEST-608（2026-08-17 审计整改）：补 @Roles（原先任何认证用户可取
 * snapshot/delta）。角色集与 route-role.policy FALLBACK 表一致
 * （global_admin/dispatcher/workshop_lead）。
 */
@Controller('api/world')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class WorldCursorController {
  constructor(private readonly worldCursorService: WorldCursorService) {}

  @Get('snapshot')
  snapshot(@Req() request?: { userContext?: OrgContext }) {
    return this.worldCursorService.getSnapshot(request?.userContext?.primaryOrgId);
  }

  @Get('delta')
  async delta(
    @Query('cursor') cursor: string,
    @Query('limit') limit?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // BUG-013 修复：cursor 参数缺失时返回400而非500。
    if (!cursor?.trim()) {
      throw new BadRequestException('cursor query parameter is required');
    }
    try {
      // NEST-639：limit 钳制上限 1000（NaN 回退默认 200）。
      const parsed = limit ? parseInt(limit, 10) : 200;
      return await this.worldCursorService.getDelta(
        cursor,
        Number.isFinite(parsed) && parsed > 0 ? parsed : 200,
        request?.userContext?.primaryOrgId,
      );
    } catch (error) {
      if (error instanceof CursorExpiredError) {
        throw new HttpException(
          { code: 'CURSOR_EXPIRED', message: error.message },
          HttpStatus.GONE,
        );
      }
      throw error;
    }
  }
}
