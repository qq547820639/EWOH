import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { AasService } from './aas.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/aas/assets')
@Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin')
export class AasController {
  constructor(private readonly aasService: AasService) {}

  @Post()
  importAsset(
    @Body() body: { assetId: string; idShort?: string; submodels?: never[] },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.aasService.importAsset(
      body as Parameters<AasService['importAsset']>[0],
      request.userContext,
    );
  }

  @Get()
  listAssets(@Req() request: { userContext?: OrgContext }) {
    // NEST-421：org 过滤。
    return this.aasService.listAssets(request.userContext);
  }

  @Get(':assetId/semantics')
  getSemantics(
    @Param('assetId') assetId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-421：org 守卫。
    return this.aasService.getSemantics(assetId, request.userContext);
  }

  @Get(':assetId')
  getAsset(
    @Param('assetId') assetId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    // NEST-421：org 守卫。
    return this.aasService.getAsset(assetId, request.userContext);
  }
}
