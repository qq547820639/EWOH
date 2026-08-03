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
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.aasService.importAsset(body as never, request.userContext);
  }

  @Get()
  listAssets() {
    return this.aasService.listAssets();
  }

  @Get(':assetId/semantics')
  getSemantics(@Param('assetId') assetId: string) {
    return this.aasService.getSemantics(assetId);
  }

  @Get(':assetId')
  getAsset(@Param('assetId') assetId: string) {
    return this.aasService.getAsset(assetId);
  }
}
