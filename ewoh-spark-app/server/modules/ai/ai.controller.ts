import { Controller, Get, Post, Put, Param, Body, Req, Res, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { AiService } from './ai.service';
import { ArkService } from './ark.service';
import { Roles } from '../shared/roles.decorator';
import type { OrgContext } from '../shared/org-context.interceptor';

const EDGE_PLATFORM_URL = (process.env.EDGE_PLATFORM_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

/**
 * R2-SMI-006 辅助：解析调用方 org 上下文——非 global_admin 且 org 缺失时
 * fail-closed 401（与 aas/alert 读面纪律一致），杜绝无租户上下文的全租户
 * 混读进入 LLM 上下文；global_admin 允许全局视角（orgId=null）。
 */
function requireOrgScope(ctx?: OrgContext): string | null {
  const orgId = ctx?.primaryOrgId?.trim() || null;
  if (!orgId && !ctx?.isGlobalAdmin) {
    throw new UnauthorizedException(
      'org 上下文缺失：AI 上下文采集必须带租户上下文（ADR-078 §15/§16）',
    );
  }
  return orgId;
}

/**
 * NEST-430：image_url 白名单——仅允许固定边缘平台（或运维显式配置的
 * VISION_IMAGE_URL_ALLOWLIST 域名后缀）的图片 URL 出站转发，用户可控
 * 字符串不再原样转递（SSRF 面收敛）。
 */
const VISION_IMAGE_URL_ALLOWLIST = (process.env.VISION_IMAGE_URL_ALLOWLIST || '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

function visionImageUrlAllowed(raw: string | undefined): boolean {
  const url = (raw ?? '').trim();
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const edgeHost = new URL(EDGE_PLATFORM_URL).hostname.toLowerCase();
  const allowHosts = VISION_IMAGE_URL_ALLOWLIST.length
    ? VISION_IMAGE_URL_ALLOWLIST
    : [edgeHost];
  return allowHosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

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

  /**
   * POST /api/ai/chat — 自然语言问答（SSE 流式）。
   * 采集系统实时上下文调用 Ark（stream:true），增量输出 `data: {delta}`
   * 事件，结束时输出 `data: {done, ok, model, answer}`；出错输出 `data: {error}`。
   * 前端用 fetch + ReadableStream 消费（POST + SSE，非 EventSource）。
   */
  @Post('chat')
  async chat(
    @Body() body: { question?: string },
    @Res() res: Response,
    @Req() request?: { userContext?: OrgContext },
  ) {
    const question = (body.question ?? '').trim();
    if (!question) {
      res.status(400).json({ ok: false, answer: '', model: '', error: 'question 不能为空。' });
      return;
    }
    // ADR-078 + R2-SMI-006：AI 上下文按本租户采集（跨租户混读关闭）；
    // 非 global_admin 且 org 缺失 fail-closed 401。
    const orgId = requireOrgScope(request?.userContext);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    try {
      let answer = '';
      for await (const { delta } of this.aiService.chatWithContextStream(question, orgId)) {
        answer += delta;
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
      const model = await this.aiService.getArkModel();
      res.write(
        `data: ${JSON.stringify({ done: true, ok: true, model, answer })}\n\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Get('snapshot-version')
  snapshotVersion(@Req() request?: { userContext?: OrgContext }) {
    // ADR-078 + R2-SMI-006：版本号按本租户聚合（跨租户混读关闭）；
    // 非 global_admin 且 org 缺失 fail-closed 401。
    const orgId = requireOrgScope(request?.userContext);
    return { version: this.aiService.getSnapshotVersion(orgId) };
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
    // NEST-430 二轮收敛（R2）：image_url 不再用户可控原样转发——
    // 仅放行固定边缘平台域（或 VISION_IMAGE_URL_ALLOWLIST
    // 显式配置的域），其余一律 400，边缘侧抓取面收敛到受控域。
    if (!visionImageUrlAllowed(body.image_url)) {
      throw new BadRequestException(
        'image_url 仅允许边缘平台（或 VISION_IMAGE_URL_ALLOWLIST 配置）域内的图片地址',
      );
    }
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
