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

  // R2-SOP-015：Record<string, never> + as never 绕过 DTO 校验（NEST-212
  // 同型）→ 显式 DTO 形状（与 service 入参签名一一对应）。
  @Post('templates')
  registerTemplate(
    @Body()
    body: {
      templateId?: string;
      name: string;
      industry?: string;
      version: string;
      parentTemplateId?: string;
      inheritanceOrder?: number;
      config?: Record<string, unknown>;
      manifest?: Record<string, unknown>;
      compatibleCore?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerTemplate(body, request.userContext);
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
    @Body()
    body: {
      packageId?: string;
      name: string;
      version: string;
      runtime: string;
      protocol: string;
      inputProfile?: string;
      outputEvents?: string[];
      configSchema?: Record<string, unknown>;
      compatibility?: Record<string, unknown>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerConnector(body, request.userContext);
  }

  @Get('connectors')
  listConnectors(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listConnectors(request.userContext);
  }

  @Post('scenario-packs')
  registerScenarioPack(
    @Body()
    body: {
      packageId?: string;
      name: string;
      version: string;
      requires?: Record<string, unknown>;
      workflows?: string[];
      policies?: string[];
      acceptance?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerScenarioPack(body, request.userContext);
  }

  @Get('scenario-packs')
  listScenarioPacks(@Req() request: { userContext?: OrgContext }) {
    return this.scaleService.listScenarioPacks(request.userContext);
  }

  @Post('mappings')
  registerMapping(
    @Body()
    body: {
      mappingId?: string;
      name: string;
      version: string;
      source: { system: string; schemaRef: string };
      target: { system: string; schemaRef: string };
      rules: Array<{
        from: string;
        to: string;
        transform?: string;
        required?: boolean;
      }>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerMapping(body, request.userContext);
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
    @Body()
    body: {
      factoryName: string;
      key: string;
      category?: string;
      value?: unknown;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerFactoryDifference(
      body,
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
    @Body()
    body: {
      packageId?: string;
      packageType: 'template' | 'connector' | 'scenario' | 'deploy' | 'mapping';
      name: string;
      version: string;
      manifest?: Record<string, unknown>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.scaleService.registerAssetPackage(body, request.userContext);
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
