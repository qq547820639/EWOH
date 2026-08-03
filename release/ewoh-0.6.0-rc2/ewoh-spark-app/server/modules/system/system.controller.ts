import { Controller, Get, Put, Param, Body, Req } from '@nestjs/common';
import { SystemService } from './system.service';
import { Roles } from '../shared/roles.decorator';

@Controller('api/system/config')
@Roles('global_admin', 'safety_admin')
export class SystemConfigController {
  constructor(private readonly systemService: SystemService) {}

  @Get()
  list() {
    return this.systemService.listConfigs();
  }

  @Get(':key')
  get(@Param('key') key: string) {
    return this.systemService.getConfig(key);
  }

  @Put(':key')
  @Roles('global_admin')
  set(
    @Param('key') key: string,
    @Body() body: { configValue?: unknown },
    @Req() request: { userContext?: { userId?: string } },
  ) {
    return this.systemService.setConfig(key, body.configValue ?? {}, request.userContext?.userId);
  }
}
