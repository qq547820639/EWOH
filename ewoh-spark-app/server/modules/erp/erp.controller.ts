import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ErpService } from './erp.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

@Controller('api/erp')
@Roles('global_admin', 'dispatcher', 'workshop_lead')
export class ErpController {
  constructor(private readonly erpService: ErpService) {}

  @Post('orders')
  receiveOrder(
    @Body() body: {
      externalOrderId: string;
      productCode: string;
      quantity: number;
      dueDate?: string;
      bom?: Array<{ materialId: string; quantity: number }>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.erpService.receiveOrder(body, request.userContext);
  }

  @Get('orders')
  listOrders(@Req() request: { userContext?: OrgContext }) {
    // NEST-407：org 过滤。
    return this.erpService.listOrders(request.userContext);
  }

  @Post('outbound')
  receiveOutbound(
    @Body() body: {
      outboundId: string;
      type: 'production_report' | 'material_consumption' | 'inventory_receipt';
      externalOrderId: string;
      payload: Record<string, unknown>;
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.erpService.receiveOutbound(body, request.userContext);
  }

  @Get('outbound')
  listOutbound(@Req() request: { userContext?: OrgContext }) {
    // NEST-407：org 过滤。
    return this.erpService.listOutbound(request.userContext);
  }

  @Post('outbound/:id/ack')
  ackOutbound(
    @Param('id') id: string,
    @Body() body: { success: boolean; error?: string },
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.erpService.ackOutbound(id, body, request.userContext);
  }

  @Post('reconcile')
  reconcile(@Req() request: { userContext?: OrgContext }) {
    // NEST-407：org 作用域核对。
    return this.erpService.reconcile(request.userContext);
  }
}
