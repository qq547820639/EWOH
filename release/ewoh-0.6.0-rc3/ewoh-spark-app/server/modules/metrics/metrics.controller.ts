import {
  Controller,
  Get,
  NotFoundException,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../shared/public.decorator';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get('metrics')
  metricsText(@Res({ passthrough: true }) response: Response): string {
    if (process.env.METRICS_ENABLED === 'false') {
      throw new NotFoundException('Metrics are disabled');
    }
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.metrics.renderPrometheus();
  }
}
