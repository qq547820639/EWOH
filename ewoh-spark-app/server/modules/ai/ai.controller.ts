import { Controller, Get, Post, Put, Param, Body } from '@nestjs/common';
import { AiService } from './ai.service';
import { ArkService } from './ark.service';
import { Roles } from '../shared/roles.decorator';

const EDGE_PLATFORM_URL = (process.env.EDGE_PLATFORM_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

@Controller('api/ai')
@Roles('dispatcher', 'global_admin')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly arkService: ArkService,
  ) {}

  /** GET /api/ai/config/status — 查询全局 AI 配置是否可用（不返回密钥本值）。 */
  @Get('config/status')
  async configStatus() {
    const cfg = await this.arkService.getConfig();
    return {
      configured: Boolean(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
    };
  }

  /** PUT /api/ai/config — 保存全局 AI 配置（供整个系统共享）。成功时不返回密钥本值。 */
  @Put('config')
  async saveConfig(@Body() body: { api_key?: string; base_url?: string; model?: string }) {
    const saved = await this.arkService.saveConfig(body);
    return {
      ok: true,
      configured: Boolean(saved.apiKey),
      baseUrl: saved.baseUrl,
      model: saved.model,
    };
  }

  /** POST /api/ai/chat — 自然语言问答（采集系统实时上下文调用 Ark）。 */
  @Post('chat')
  chat(@Body() body: { question?: string }) {
    const question = (body.question ?? '').trim();
    if (!question) {
      return { ok: false, answer: '', model: '', error: 'question 不能为空。' };
    }
    return this.aiService.chatWithContext(question);
  }

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
