import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { AiService } from './ai.service';
import { Roles } from '../shared/roles.decorator';

const EDGE_PLATFORM_URL = (process.env.EDGE_PLATFORM_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

@Controller('api/ai')
@Roles('dispatcher', 'global_admin')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('snapshot-version')
  snapshotVersion() {
    return { version: this.aiService.getSnapshotVersion() };
  }

  @Post('suggestions')
  suggestion(
    @Body()
    body: {
      triggeredBy: string;
      problem: string;
      snapshot: { version: number; from: string; to: string; records: number };
    },
  ) {
    return this.aiService.createSuggestion(body);
  }

  @Post('plans')
  plan(@Body() body: { suggestionId: string; content: Record<string, unknown> }) {
    return this.aiService.createPlan(body.suggestionId, body.content ?? {});
  }

  @Get('suggestions/:id')
  getSuggestion(@Param('id') id: string) {
    return this.aiService.getSuggestion(id);
  }

  @Get('plans/:id')
  getPlan(@Param('id') id: string) {
    return this.aiService.getPlan(id);
  }

  /**
   * POST /api/ai/vision/understand — 视觉理解代理。
   * 转发到边缘平台 /api/vision/understand，支持请求级 api_key/base_url/model 覆盖。
   */
  @Post('vision/understand')
  async visionUnderstand(
    @Body()
    body: {
      image_url?: string;
      question?: string;
      api_key?: string;
      base_url?: string;
      model?: string;
    },
  ) {
    const res = await fetch(`${EDGE_PLATFORM_URL}/api/vision/understand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: body.image_url || '',
        question: body.question || '',
        api_key: body.api_key || '',
        base_url: body.base_url || '',
        model: body.model || '',
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
}
