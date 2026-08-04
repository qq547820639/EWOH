import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { MesService, CreateWorkOrderDto } from './mes.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/mes')
@Roles('global_admin', 'dispatcher', 'workshop_lead', 'safety_admin')
export class MesController {
  constructor(private readonly mesService: MesService) {}

  @Get('work-orders')
  list() {
    return this.mesService.listWorkOrders();
  }

  @Post('work-orders')
  create(@Body() body: CreateWorkOrderDto, @Req() request: { userContext?: OrgContext }) {
    return this.mesService.createWorkOrder(body, request.userContext);
  }

  @Get('work-orders/:id')
  get(@Param('id') id: string) {
    return this.mesService.getWorkOrder(id);
  }

  @Get('work-orders/:id/trace')
  trace(@Param('id') id: string) {
    return this.mesService.getTrace(id);
  }

  @Post('work-orders/:id/state')
  transition(
    @Param('id') id: string,
    @Query('action') action: string,
    @Body() body: Record<string, unknown>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.transitionWorkOrder(id, action, body, request.userContext);
  }

  @Post('work-orders/:id/steps/:stepId/state')
  transitionStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Query('action') action: string,
    @Body() body: Record<string, unknown>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.transitionStep(id, stepId, action, body, request.userContext);
  }

  @Post('work-orders/:id/steps/:stepId/force-resolve')
  forceResolveStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() body: {
      resolution: 'local' | 'server';
      idempotencyKey?: string;
      action?: string;
      payload?: Record<string, unknown>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.forceResolveStep(id, stepId, body, request.userContext);
  }

  @Post('work-orders/:id/materials')
  consumeMaterial(
    @Param('id') id: string,
    @Body() body: { materialId: string; quantity: number; reason?: string; operatorId?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.consumeMaterial(id, body, request.userContext);
  }

  @Get('work-orders/:id/materials')
  listMaterials(@Param('id') id: string) {
    return this.mesService.listMaterials(id);
  }

  @Post('work-orders/:id/inspections')
  qualityInspection(
    @Param('id') id: string,
    @Body() body: {
      stepId: string;
      inspectorId?: string;
      result: 'pass' | 'fail' | 'rework';
      defectCode?: string;
      quantity?: number;
      note?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.qualityInspection(id, body, request.userContext);
  }

  @Get('sops')
  listSops() {
    return this.mesService.listSops();
  }

  @Post('sops')
  registerSop(
    @Body() body: {
      sopId?: string;
      title: string;
      version: string;
      steps: Array<{
        name: string;
        instruction?: string;
        mandatory?: boolean;
        media?: string[];
        tools?: string[];
        materials?: string[];
      }>;
      effectiveFrom?: string;
      effectiveTo?: string;
      checksum?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.registerSop(body, request.userContext);
  }

  @Get('sops/:id')
  getSop(@Param('id') id: string) {
    return this.mesService.getSop(id);
  }

  @Post('sops/:id/publish')
  publishSop(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.publishSop(id, request.userContext);
  }

  @Get('sops/:id/diff/:otherId')
  diffSops(@Param('id') id: string, @Param('otherId') otherId: string) {
    return this.mesService.diffSops(id, otherId);
  }

  @Get('quality-schemes')
  listQualitySchemes() {
    return this.mesService.listQualitySchemes();
  }

  @Get('quality-schemes/match')
  matchQualitySchemes(
    @Query('deviceId') deviceId?: string,
    @Query('stepType') stepType?: string,
    @Query('productCode') productCode?: string,
  ) {
    return this.mesService.matchQualitySchemes({
      deviceId,
      stepType,
      productCode,
    });
  }

  @Post('quality-schemes')
  registerQualityScheme(
    @Body() body: {
      schemeId?: string;
      name: string;
      version: string;
      stage: 'first' | 'in_process' | 'final';
      checkItems: Array<{
        itemId: string;
        name: string;
        required?: boolean;
        defectCode?: string;
      }>;
      deviceIds?: string[];
      stepTypes?: string[];
      productCodes?: string[];
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.registerQualityScheme(body, request.userContext);
  }

  @Get('quality-schemes/:id')
  getQualityScheme(@Param('id') id: string) {
    return this.mesService.getQualityScheme(id);
  }

  @Post('quality-schemes/:id/publish')
  publishQualityScheme(
    @Param('id') id: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mesService.publishQualityScheme(id, request.userContext);
  }
}
