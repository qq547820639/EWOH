import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { DeviceResponsibilityService } from './device-responsibility.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 设备责任人 API（NO-49a）。
 *
 * 读：任何已认证的现场/管理角色都能看到"这台设备谁负责"（现场协调需要这个信息）。
 * 写：班组长 / 安全员 / 管理员（把设备交给谁是管理判断，与安灯更正同一档权限）。
 */
@Controller('api/devices')
export class DeviceResponsibilityController {
  constructor(private readonly responsibilities: DeviceResponsibilityService) {}

  @Get(':deviceId/responsibilities')
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin', 'worker')
  list(
    @Param('deviceId') deviceId: string,
    @Query('activeOnly') activeOnly: string | undefined,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.responsibilities.list(String(request?.userContext?.primaryOrgId ?? ''), {
      deviceId,
      activeOnly: activeOnly === 'false' ? false : true,
    });
  }

  @Post(':deviceId/responsibilities')
  @Roles('global_admin', 'workshop_lead', 'safety_admin')
  set(
    @Param('deviceId') deviceId: string,
    @Body() body: { personId?: string; responsibility?: string; shiftId?: string; note?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.responsibilities.setResponsibility(
      String(request?.userContext?.primaryOrgId ?? ''),
      {
        deviceId,
        personId: String(body?.personId ?? ''),
        responsibility: String(body?.responsibility ?? ''),
        // NO-51a：班次维度（缺省 = 全天）
        ...(body?.shiftId ? { shiftId: body.shiftId } : {}),
        ...(body?.note ? { note: body.note } : {}),
      },
      request?.userContext,
    );
  }

  @Delete(':deviceId/responsibilities/:responsibility')
  @Roles('global_admin', 'workshop_lead', 'safety_admin')
  clear(
    @Param('deviceId') deviceId: string,
    @Param('responsibility') responsibility: string,
    @Query('reason') reason: string | undefined,
    @Query('shiftId') shiftId: string | undefined,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.responsibilities.clearResponsibility(
      String(request?.userContext?.primaryOrgId ?? ''),
      {
        deviceId,
        responsibility,
        ...(shiftId ? { shiftId } : {}),
        ...(reason ? { reason } : {}),
      },
      request?.userContext,
    );
  }
}

/**
 * 责任关系的**批量读**入口（NO-50a 页面需要）。
 *
 * 为什么单独一个前缀：设备台账页面一次展示几十台设备，逐台请求会变成 N+1；
 * 而 `/api/devices/responsibilities` 会和既有 `GET /api/devices/:id` 撞路径
 * （`:id` 会先匹配到），因此用独立前缀 `api/device-responsibilities`。
 */
@Controller('api/device-responsibilities')
export class DeviceResponsibilityBatchController {
  constructor(private readonly responsibilities: DeviceResponsibilityService) {}

  /**
   * NO-52a：给定班次的责任人核对快照（交接班前后台/页面都用它）。
   * 不传 `shiftId` = 用当前班次；传 `shiftId=`（空）语义等同"班次未知"，由服务端显式标注。
   */
  @Get('coverage')
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin')
  coverage(
    @Query('shiftId') shiftId: string | undefined,
    @Req() request?: { userContext?: OrgContext },
  ) {
    return this.responsibilities.coverageForShift(
      String(request?.userContext?.primaryOrgId ?? ''),
      shiftId === undefined ? {} : { shiftId: shiftId.trim() === '' ? null : shiftId },
    );
  }

  @Get()
  @Roles('global_admin', 'dispatcher', 'workshop_lead', 'device_ops', 'safety_admin', 'worker')
  list(
    @Query('deviceIds') deviceIds: string | undefined,
    @Query('activeOnly') activeOnly: string | undefined,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const ids = String(deviceIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    return this.responsibilities.listForDevices(
      String(request?.userContext?.primaryOrgId ?? ''),
      ids,
      { activeOnly: activeOnly === 'false' ? false : true },
    );
  }
}
