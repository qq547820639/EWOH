import { Controller, Get, Query, Req } from '@nestjs/common';
import { OrderChainService } from './order-chain.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 订单链 API（NO-57a，§6 世界模型消费面）。
 *
 *  - GET /api/world/order-chains               未完工订单的"订单→任务/工序→物料"链路（含断链缺口）
 *
 * 只读查询面：不写业务事实。缺口（无任务/无工序/无物料/无期限）显式返回，不静默省略。
 */
@Controller('api/world/order-chains')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class OrderChainController {
  constructor(private readonly service: OrderChainService) {}

  @Get()
  list(
    @Query('limit') limit: string | undefined,
    @Query('orderNo') orderNo: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.service.list(request.userContext, {
      limit: limit ? Number(limit) : undefined,
      orderNo,
    });
  }
}
