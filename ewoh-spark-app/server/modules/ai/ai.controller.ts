import { Controller, Get, Post, Put, Param, Body, Req } from '@nestjs/common';
import { AiService } from './ai.service';
import { ArkService } from './ark.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

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

  /**
   * PUT /api/ai/config — 保存全局 AI 配置（供整个系统共享）。成功时不返回密钥本值。
   * NEST-413：全局哨兵 org 凭据（API key/base_url）收紧为 global_admin 专属
   * （approval.yaml high_privilege_admin 同款语义；dispatcher 不再可改全局配置）。
   */
  @Put('config')
  @Roles('global_admin')
  async saveConfig(
    @Body() body: { api_key?: string; base_url?: string; model?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    const saved = await this.arkService.saveConfig(body, request?.userContext);
    return {
      ok: true,
      configured: Boolean(saved.apiKey),
      baseUrl: saved.baseUrl,
      model: saved.model,
    };
  }

  /** POST /api/ai/chat — 自然语言问答（采集系统实时上下文调用 Ark）。 */
  @Post('chat')
  chat(
    @Body() body: { question?: string },
    @Req() request?: { userContext?: OrgContext },
  ) {
    const question = (body.question ?? '').trim();
    if (!question) {
      return { ok: false, answer: '', model: '', error: 'question 不能为空。' };
    }
    // ADR-078：AI 上下文按本租户采集（跨租户混读关闭）。
    return this.aiService.chatWithContext(question, request?.userContext?.primaryOrgId ?? null);
  }

  @Get('snapshot-version')
  snapshotVersion(@Req() request?: { userContext?: OrgContext }) {
    // ADR-078：版本号按本租户聚合（跨租户混读关闭）。
    return { version: this.aiService.getSnapshotVersion(request?.userContext?.primaryOrgId ?? null) };
  }

  @Post('suggestions')
  suggestion(
    @Body()
    body: {
      triggeredBy: string;
      problem: string;
      snapshot: { version: number; from: string; to: string; records: number };
    },
    @Req() request: { userContext?: OrgContext },
  ) {
    // NO-08a（ADR-019）：推理结果台账的租户上下文（请求级 GUC 注入）。
    return this.aiService.createSuggestion({
      ...body,
      orgId: request.userContext?.primaryOrgId?.trim() || '',
    });
  }

  @Post('plans')
  plan(
    @Body() body: { suggestionId: string; content: Record<string, unknown> },
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-422：按租户作用域创建/校验建议归属。
    return this.aiService.createPlan(
      body.suggestionId,
      body.content ?? {},
      request?.userContext,
    );
  }

  @Get('suggestions/:id')
  getSuggestion(
    @Param('id') id: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-422：org 守卫（跨租户 404）。
    return this.aiService.getSuggestion(id, request?.userContext);
  }

  @Get('plans/:id')
  getPlan(
    @Param('id') id: string,
    @Req() request?: { userContext?: OrgContext },
  ) {
    // NEST-422：org 守卫（跨租户 404）。
    return this.aiService.getPlan(id, request?.userContext);
  }

  /**
   * POST /api/ai/vision/understand — 视觉理解代理。
   * 转发到边缘平台 /api/vision/understand。
   * NEST-430（SSRF 收敛）：不再转发用户可控 api_key/base_url——服务端凭据
   * 由边缘侧全局配置持有，用户输入不可指定出站目标；model 白名单透传。
   */
  @Post('vision/understand')
  async visionUnderstand(
    @Body()
    body: {
      image_url?: string;
      question?: string;
      model?: string;
    },
  ) {
    const res = await fetch(`${EDGE_PLATFORM_URL}/api/vision/understand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: body.image_url || '',
        question: body.question || '',
        model: body.model || '',
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
}
