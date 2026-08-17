import { Controller, Get, Param, Query, NotFoundException, Req } from '@nestjs/common';
import { SpatialService } from './spatial.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/spatial')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class SpatialController {
  constructor(private readonly spatialService: SpatialService) {}

  @Get('entities')
  async getEntities(
    @Query('type') type?: string,
    @Query('parentId') parentId?: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.spatialService.getEntities(
      type || parentId ? { type, parentId } : undefined,
      request?.userContext,
    );
  }

  @Get('entities/:entityId')
  async getEntity(
    @Param('entityId') entityId: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const entity = await this.spatialService.getEntity(entityId, request?.userContext);
    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }
    return entity;
  }

  @Get('topology')
  async getTopology(@Req() request?: { userContext?: OrgContext }) {
    return this.spatialService.getTopology(request?.userContext);
  }

  @Get('hierarchy')
  async getHierarchy(@Req() request?: { userContext?: OrgContext }) {
    return this.spatialService.getHierarchy(request?.userContext);
  }
}
