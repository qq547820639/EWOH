import { Controller, Get, Put, Post, Param, Body, Req } from '@nestjs/common';
import { SystemService } from './system.service';
import { ANY_AUTHENTICATED_ROLES, Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

interface SystemRequestContext {
  userContext?: OrgContext;
}

@Controller('api/system/config')
@Roles('global_admin', 'safety_admin')
export class SystemConfigController {
  constructor(private readonly systemService: SystemService) {}

  @Get()
  list(@Req() request: SystemRequestContext) {
    return this.systemService.listConfigs(request.userContext);
  }

  @Get(':key')
  get(@Param('key') key: string, @Req() request: SystemRequestContext) {
    return this.systemService.getConfig(key, request.userContext);
  }

  @Put(':key')
  @Roles('global_admin')
  set(
    @Param('key') key: string,
    @Body() body: { configValue?: unknown },
    @Req() request: SystemRequestContext,
  ) {
    return this.systemService.setConfig(
      key,
      body.configValue ?? {},
      request.userContext?.userId,
      request.userContext?.primaryOrgId,
    );
  }
}

@Controller('api/system/feature-flags')
@Roles(...ANY_AUTHENTICATED_ROLES)
export class FeatureFlagsController {
  constructor(private readonly systemService: SystemService) {}

  @Get()
  list(@Req() request: SystemRequestContext) {
    return this.systemService.listFeatureFlags(request.userContext);
  }

  @Get(':key')
  get(@Param('key') key: string, @Req() request: SystemRequestContext) {
    return this.systemService.getFeatureFlag(key, request.userContext);
  }

  @Put(':key')
  @Roles('global_admin')
  set(
    @Param('key') key: string,
    @Body() body: { enabled?: boolean; metadata?: Record<string, unknown> },
    @Req() request: SystemRequestContext,
  ) {
    return this.systemService.setFeatureFlag(
      key,
      body.enabled ?? false,
      body.metadata ?? {},
      request.userContext?.userId,
      request.userContext?.primaryOrgId,
    );
  }

  /**
   * NEST-613（2026-08-17 审计整改）：评估上下文的身份字段（orgId/roles）
   * 一律取服务端 userContext——请求体 context.orgId/roles 可伪造跨租户
   * 评估，现被显式忽略；非身份字段（factoryId/upgradeRing）仍可由调用方提供。
   */
  @Post('evaluate')
  evaluate(
    @Body()
    body: {
      keys?: string[];
      context?: {
        orgId?: string;
        factoryId?: string;
        upgradeRing?: string;
        roles?: string[];
      };
    },
    @Req() request: SystemRequestContext,
  ) {
    const serverContext = {
      orgId: request.userContext?.primaryOrgId ?? '',
      roles:
        Array.isArray(request.userContext?.roles) && request.userContext!.roles!.length > 0
          ? request.userContext!.roles!
          : request.userContext?.role
            ? [request.userContext.role]
            : [],
      factoryId: body.context?.factoryId,
      upgradeRing: body.context?.upgradeRing,
    };
    return this.systemService.evaluateFeatureFlags(
      body.keys,
      serverContext,
      request.userContext,
    );
  }
}
