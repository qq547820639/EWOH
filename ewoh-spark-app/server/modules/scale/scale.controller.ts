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
  listTemplates(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listTemplates(request.userContext);
  }

  @Get('templates/:id')
  getTemplate(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.getTemplate(id, request.userContext);
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
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.diffPreview(id, body, request.userContext);
  }

  @Get('profiles')
  listProfiles(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listProfiles(request.userContext);
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
  listConnectors(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listConnectors(request.userContext);
  }

  @Post('scenario-packs')
  registerScenarioPack(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerScenarioPack(body as never, request.userContext);
  }

  @Get('scenario-packs')
  listScenarioPacks(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listScenarioPacks(request.userContext);
  }

  @Post('mappings')
  registerMapping(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerMapping(body as never, request.userContext);
  }

  @Get('mappings')
  listMappings(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listMappings(request.userContext);
  }

  @Get('mappings/:id')
  getMapping(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.getMapping(id, request.userContext);
  }

  @Post('mappings/:id/dry-run')
  dryRunMapping(
    @Param('id') id: string,
    @Body() body: { sample: Record<string, unknown> },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.dryRunMapping(
      id,
      body?.sample,
      request.userContext,
    );
  }

  @Post('scenario-packs/:id/install')
  installScenarioPack(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.installScenarioPack(id, request.userContext);
  }

  @Post('scenario-packs/:id/uninstall')
  uninstallScenarioPack(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.uninstallScenarioPack(id, request.userContext);
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
  fleetStatus(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.fleetStatus(request.userContext);
  }

  @Get('compatibility')
  compatibilityCatalog(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.compatibilityCatalog(request.userContext);
  }

  @Get('metrics')
  scaleMetrics(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.scaleMetrics(request.userContext);
  }

  @Post('differences')
  registerFactoryDifference(
    @Body() body: Record<string, never>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerFactoryDifference(
      body as never,
      request.userContext,
    );
  }

  @Get('differences')
  listFactoryDifferences(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listFactoryDifferences(request.userContext);
  }

  @Post('differences/:key/resolve')
  resolveFactoryDifference(
    @Param('key') key: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.resolveFactoryDifference(
      key,
      request.userContext,
    );
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
  listAssetPackages(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listAssetPackages(request.userContext);
  }

  @Get('assets/:id')
  getAssetPackage(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.getAssetPackage(id, request.userContext);
  }

  @Post('assets/:id/conformance')
  runConformance(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.runConformance(id, request.userContext);
  }
}
