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
  listOrders() {
    return this.erpService.listOrders();
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
  listOutbound() {
    return this.erpService.listOutbound();
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
  reconcile() {
    return this.erpService.reconcile();
  }
}
