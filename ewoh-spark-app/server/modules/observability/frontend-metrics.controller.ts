import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { FrontendMetricsService, type FrontendMetricsPayload } from './frontend-metrics.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Frontend metrics ingestion + diagnostic query API.
 *
 * 端点：
 *  - POST /api/observability/frontend-metrics  浏览器指标批量摄取（org 绑定）
 *  - GET  /api/observability/frontend-metrics  运维查询（限角色，按 org 隔离）
 *
 * 鉴权：复用请求中的 userContext（由全局鉴权/org-context 拦截器注入），
 *       因此组织隔离由服务端从令牌解析，绝不信任前端 role 参数。
 * 限流：服务内 in-memory 令牌桶（默认 1000 req/min/主题），无需外部 Redis。
 */
@Controller('api/observability/frontend-metrics')
export class FrontendMetricsController {
  constructor(private readonly service: FrontendMetricsService) {}

  @Post()
  ingest(
    @Body() payload: FrontendMetricsPayload,
    @Req() request: { userContext?: OrgContext },
  ): { accepted: number; reason?: string } {
    const orgId = request.userContext?.primaryOrgId;
    if (!orgId) {
      throw new HttpException(
        { code: 'ORG_REQUIRED', message: '缺少组织上下文' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit = this.service.rateLimit(request.userContext?.userId ?? orgId);
    if (!limit.allowed) {
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests', details: { remaining: 0 } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return this.service.ingest(payload, {
        orgId,
        userId: request.userContext?.userId,
      });
    } catch (error) {
      throw new HttpException(
        { code: 'INVALID_METRICS', message: String((error as Error).message || error) },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get()
  @Roles('global_admin', 'safety_admin', 'dispatcher', 'workshop_lead')
  query(
    @Query('limit') limit: string | undefined,
    @Query('metric') metric: string | undefined,
    @Query('orgId') orgIdParam: string | undefined,
    @Req() request: { userContext?: OrgContext },
  ) {
    const ctx = request.userContext;
    // 全局管理员可指定 org；否则强制限定到请求者组织。
    const orgId =
      ctx?.isGlobalAdmin && orgIdParam ? orgIdParam : ctx?.primaryOrgId;
    if (!orgId) {
      throw new HttpException(
        { code: 'ORG_REQUIRED', message: '缺少组织上下文' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      orgId,
      summary: this.service.summary(),
      metrics: this.service.query(orgId, {
        limit: limit ? parseInt(limit, 10) : 100,
        metricName: metric,
      }),
    };
  }
}
