import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Req,
  Res,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from '../shared/public.decorator';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * NEST-427（/metrics 鉴权）：
   * - METRICS_BEARER_TOKEN 已配置 → 要求 Authorization: Bearer（constant-time）；
   * - 未配置且 production → fail-closed 404（不暴露运营数据）；
   * - 未配置且非 production → 保持开放（本地开发可观测）。
   */
  @Public()
  @Get('metrics')
  metricsText(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): string {
    if (process.env.METRICS_ENABLED === 'false') {
      throw new NotFoundException('Metrics are disabled');
    }
    const bearerToken = process.env.METRICS_BEARER_TOKEN?.trim();
    if (bearerToken) {
      const presented = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';
      if (
        presented.length !== bearerToken.length ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(bearerToken))
      ) {
        throw new HttpException('Metrics token required', HttpStatus.UNAUTHORIZED);
      }
    } else if (
      (process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    ) {
      throw new NotFoundException('Metrics are disabled');
    }
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.metrics.renderPrometheus();
  }
}
