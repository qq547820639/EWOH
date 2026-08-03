import { Controller, Get, Put, Param, Body, Req } from '@nestjs/common';
import { SystemService } from './system.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';

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

@Controller('api/system/feature-flags')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class FeatureFlagsController {
  constructor(private readonly systemService: SystemService) {}

  @Get()
  list() {
    return this.systemService.listFeatureFlags();
  }

  @Get(':key')
  get(@Param('key') key: string) {
    return this.systemService.getFeatureFlag(key);
  }

  @Put(':key')
  @Roles('global_admin')
  set(
    @Param('key') key: string,
    @Body() body: { enabled?: boolean; metadata?: Record<string, unknown> },
    @Req() request: { userContext?: { userId?: string } },
  ) {
    return this.systemService.setFeatureFlag(
      key,
      body.enabled ?? false,
      body.metadata ?? {},
      request.userContext?.userId,
    );
  }
}
