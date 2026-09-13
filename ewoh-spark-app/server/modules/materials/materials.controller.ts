import { Controller, Get, Req } from '@nestjs/common';
import { MaterialsService } from './materials.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 物料库存读面（NO-27a）。
 *
 * 面向调度员/班组长/设备运维/全局管理员：库存来自 ERP 出站事件的投影，
 * 响应同时给出"无法解析的历史载荷"与扫描量——数据缺口必须看得见（原则 7）。
 */
@Controller('api/materials')
@Roles('dispatcher', 'workshop_lead', 'device_ops', 'global_admin')
export class MaterialsController {
  constructor(private readonly materialsService: MaterialsService) {}

  @Get('inventory')
  inventory(@Req() request: { userContext?: OrgContext }) {
    return this.materialsService.getInventory(request.userContext);
  }

  @Get('movement-types')
  movementTypes() {
    return { types: this.materialsService.listMovementTypes() };
  }
}
