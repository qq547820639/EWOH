import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ShiftService } from './shift.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 班次写面角色（登记班次定义 / 登记交接）。
 *
 * 与班次工作台入口角色同源（client/src/lib/navigation.ts `shift-workbench`：
 * global_admin / dispatcher / workshop_lead / safety_admin）。此前写面只继承类级
 * ANY_AUTHENTICATED_ROLES，等于把 viewer/worker 也放进来：班次定义是全厂排班与
 * "当前班"口径的输入，一次误写会让所有中心的"现在是什么班"整体漂移。
 * 读面保持 broad（查看班次不需要写权限），只有写面收敛。
 */
export const SHIFT_WRITE_ROLES = [
  'global_admin',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
] as const;

/**
 * 班次域 API（standalone_074，DR-2 班次工作台）。
 *
 *  - GET  /api/shifts                    班次定义列表（?activeOnly=true）
 *  - GET  /api/shifts/current            当前班次 + 下一班（无匹配 → current=null 显式未知）
 *  - POST /api/shifts                    登记班次定义（HH:mm 窗口 + 跨零点）
 *  - GET  /api/shifts/handovers          交接班记录（?shiftId=&limit=）
 *  - POST /api/shifts/handovers          登记交接（结构化遗留事项 + ShiftHandoverRecorded 事件）
 */
@Controller('api/shifts')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  @Get()
  list(@Query('activeOnly') activeOnly: string | undefined, @Req() request: { userContext?: OrgContext }) {
    return this.shiftService.listShifts(request.userContext, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @Get('current')
  current(@Req() request: { userContext?: OrgContext }) {
    return this.shiftService.resolveCurrentShift(request.userContext);
  }

  @Post()
  @Roles(...SHIFT_WRITE_ROLES)
  upsert(@Body() body: Record<string, unknown>, @Req() request: { userContext?: OrgContext }) {
    return this.shiftService.upsertShift(body as never, request.userContext);
  }

  @Get('handovers')
  handovers(
    @Query('shiftId') shiftId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    return this.shiftService.listHandovers(request.userContext, {
      shiftId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('handovers')
  @Roles(...SHIFT_WRITE_ROLES)
  createHandover(@Body() body: Record<string, unknown>, @Req() request: { userContext?: OrgContext }) {
    return this.shiftService.createHandover(body as never, request.userContext);
  }
}
