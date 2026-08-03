import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { MobileService } from './mobile.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/mobile')
@Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'worker')
export class MobileController {
  constructor(private readonly mobileService: MobileService) {}

  @Get('workbench')
  workbench(
    @Query('personId') personId: string,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mobileService.listWorkbench(personId, request.userContext);
  }

  @Post('workbench/scan')
  scan(
    @Body() body: { scanValue?: string; orderId?: string },
  ) {
    return this.mobileService.scan(body.scanValue ?? body.orderId ?? '');
  }

  @Get('workbench/orders/:orderId')
  order(@Param('orderId') orderId: string) {
    return this.mobileService.getOrder(orderId);
  }

  @Post('workbench/orders/:orderId/steps/:stepId/state')
  transitionStep(
    @Param('orderId') orderId: string,
    @Param('stepId') stepId: string,
    @Query('action') action: string,
    @Body() body: Record<string, unknown>,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mobileService.transitionStep(
      orderId,
      stepId,
      action,
      body,
      request.userContext,
    );
  }

  @Post('workbench/orders/:orderId/steps/:stepId/quality')
  inspectStep(
    @Param('orderId') orderId: string,
    @Param('stepId') stepId: string,
    @Body() body: {
      result: 'pass' | 'fail' | 'rework';
      defectCode?: string;
      quantity?: number;
      note?: string;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.mobileService.inspectStep(
      orderId,
      {
        stepId,
        result: body.result,
        defectCode: body.defectCode,
        quantity: body.quantity,
        note: body.note,
      },
      request.userContext,
    );
  }
}
