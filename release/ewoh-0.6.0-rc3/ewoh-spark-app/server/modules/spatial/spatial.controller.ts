import { Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { SpatialService } from './spatial.service';
import { Roles } from '../shared/roles.decorator';

@Controller('api/spatial')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class SpatialController {
  constructor(private readonly spatialService: SpatialService) {}

  @Get('entities')
  async getEntities(
    @Query('type') type?: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.spatialService.getEntities(
      type || parentId ? { type, parentId } : undefined,
    );
  }

  @Get('entities/:entityId')
  async getEntity(@Param('entityId') entityId: string) {
    const entity = await this.spatialService.getEntity(entityId);
    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }
    return entity;
  }

  @Get('topology')
  async getTopology() {
    return this.spatialService.getTopology();
  }

  @Get('hierarchy')
  async getHierarchy() {
    return this.spatialService.getHierarchy();
  }
}
