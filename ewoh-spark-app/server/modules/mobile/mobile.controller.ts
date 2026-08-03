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
@Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops')
export class MobileController {
  constructor(private readonly mobileService: MobileService) {}

  @Get('workbench')
  workbench(@Query('personId') personId: string) {
    return this.mobileService.listWorkbench(personId);
  }

  @Post('workbench/scan')
  scan(@Body() body: { orderId: string }) {
    return this.mobileService.scanOrder(body.orderId);
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
}
