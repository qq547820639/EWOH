import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ScaleService } from './scale.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/scale')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class ScaleController {
  constructor(private readonly scaleService: ScaleService) {}

  @Post('templates')
  registerTemplate(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerTemplate(body as never, request.userContext);
  }

  @Get('templates')
  listTemplates() {
    return this.scaleService.listTemplates();
  }

  @Get('templates/:id')
  getTemplate(@Param('id') id: string) {
    return this.scaleService.getTemplate(id);
  }

  @Post('templates/:id/state')
  transitionTemplate(
    @Param('id') id: string,
    @Query('action') action: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.transitionTemplate(id, action, request.userContext);
  }

  @Post('templates/:id/install')
  installTemplate(
    @Param('id') id: string,
    @Body() body: { factoryName: string; config?: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.installTemplate(id, body, request.userContext);
  }

  @Post('templates/:id/diff-preview')
  diffPreview(
    @Param('id') id: string,
    @Body() body: { config?: Record<string, unknown> },
  ) {
    return this.scaleService.diffPreview(id, body);
  }

  @Get('profiles')
  listProfiles() {
    return this.scaleService.listProfiles();
  }

  @Post('profiles/:id/replay')
  replayProfile(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.replayProfile(id, request.userContext);
  }

  @Post('connectors')
  registerConnector(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerConnector(body as never, request.userContext);
  }

  @Get('connectors')
  listConnectors() {
    return this.scaleService.listConnectors();
  }

  @Post('scenario-packs')
  registerScenarioPack(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerScenarioPack(body as never, request.userContext);
  }

  @Get('scenario-packs')
  listScenarioPacks() {
    return this.scaleService.listScenarioPacks();
  }

  @Post('mappings')
  registerMapping(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerMapping(body as never, request.userContext);
  }

  @Get('mappings')
  listMappings() {
    return this.scaleService.listMappings();
  }

  @Get('mappings/:id')
  getMapping(@Param('id') id: string) {
    return this.scaleService.getMapping(id);
  }

  @Post('scenario-packs/:id/install')
  installScenarioPack(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.installScenarioPack(id, request.userContext);
  }

  @Post('fleet/upgrade')
  fleetUpgrade(
    @Body() body: { packageId: string; ring?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.fleetUpgrade(
      body.packageId,
      request.userContext,
      body.ring,
    );
  }

  @Post('fleet/rollback')
  fleetRollback(
    @Body() body: { ring?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.fleetRollback(
      request.userContext,
      body?.ring,
    );
  }

  @Get('fleet/status')
  fleetStatus() {
    return this.scaleService.fleetStatus();
  }

  @Get('compatibility')
  compatibilityCatalog() {
    return this.scaleService.compatibilityCatalog();
  }

  @Get('metrics')
  scaleMetrics() {
    return this.scaleService.scaleMetrics();
  }

  @Post('fleet/support-bundle')
  generateSupportBundle(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.generateSupportBundle(request.userContext);
  }

  @Post('golden-factory/install')
  installGoldenFactory(
    @Body() body: { factoryName: string; config?: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.installGoldenFactory(body, request.userContext);
  }

  @Post('assets')
  registerAssetPackage(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerAssetPackage(body as never, request.userContext);
  }

  @Get('assets')
  listAssetPackages() {
    return this.scaleService.listAssetPackages();
  }

  @Get('assets/:id')
  getAssetPackage(@Param('id') id: string) {
    return this.scaleService.getAssetPackage(id);
  }

  @Post('assets/:id/conformance')
  runConformance(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.runConformance(id, request.userContext);
  }
}
