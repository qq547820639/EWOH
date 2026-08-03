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
}
