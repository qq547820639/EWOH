import { Controller, Get, Post, Put, Param, Body, Req, Res, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { AiService } from './ai.service';
import { ArkService } from './ark.service';
import { Roles } from '../shared/roles.decorator';
import {
  buildGucSettings,
  StreamingResponse,
  type GucSetting,
  type OrgContext,
} from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';

const EDGE_PLATFORM_URL = (process.env.EDGE_PLATFORM_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');

/**
 * AI 能力接入修复（2026-08-18）：api → 边缘平台 转发认证。
 * 边缘平台 production 模式写路径需 Bearer token（query_assistant 权限）——
 * 此前转发未携带 Authorization → 边缘平台 401 → 前端"连接失败"。
 * 服务账号凭据由运维环境变量配置（EDGE_PLATFORM_USERNAME/PASSWORD），
 * 缺省使用边缘平台 OfflineIdentityBackend 预置 admin 账号（与种子一致）；
 * 用户不可控（NEST-430 收敛原则：出站身份固定，非用户凭据）。
 * session token TTL 24h，本地缓存 12h 提前续期。
 */
const EDGE_PLATFORM_USERNAME = process.env.EDGE_PLATFORM_USERNAME || 'admin';
const EDGE_PLATFORM_PASSWORD = process.env.EDGE_PLATFORM_PASSWORD || 'admin123';
let edgeTokenCache: { token: string; expiresAt: number } | null = null;

async function getEdgePlatformToken(): Promise<string> {
  if (edgeTokenCache && Date.now() < edgeTokenCache.expiresAt) {
    return edgeTokenCache.token;
  }
  const res = await fetch(`${EDGE_PLATFORM_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: EDGE_PLATFORM_USERNAME,
      password: EDGE_PLATFORM_PASSWORD,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`边缘平台服务账号登录失败: HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string };
  if (!data.token) {
    throw new Error('边缘平台服务账号登录未返回 token');
  }
  edgeTokenCache = { token: data.token, expiresAt: Date.now() + 12 * 3600 * 1000 };
  return data.token;
}

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
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  /**
   * 流式端点的租户 GUC 设置。
   *
   * 为什么流式端点还要自己开事务：OrgContextInterceptor 对 @StreamingResponse()
   * 端点只豁免"把整条流包进一个长事务"，**不豁免租户收敛**——RLS 照常生效，
   * ewoh_api 是 NOBYPASSRLS 的 service_role 成员，没有 app.current_org_ids 时
   * ewoh_org_visible() 恒 false：读会静默读空、写会被 WITH CHECK 拒绝。所以
   * 每个 DB 步都必须自带 GUC。
   *
   * 无 userId 时返回 undefined（调用方直通，绝不猜上下文）。
   */
  private streamTenantSettings(context?: OrgContext): GucSetting[] | undefined {
    if (!context?.userId) {
      return undefined;
    }
    if (context.primaryOrgId) {
      return buildGucSettings(context);
    }
    // global_admin 允许无主 org（orgId=null）的全局视角：buildGucSettings 会下发
    // 空值 app.current_org_id / current_org_ids，故只下发 user_id + is_global_admin。
    return [
      { name: 'app.user_id', value: context.userId },
      {
        name: 'app.is_global_admin',
        value: context.isGlobalAdmin ? 'true' : 'false',
      },
    ];
  }

  /**
   * 在带租户 GUC 的短事务里推进流式生成器**一步**。
   *
   * 为什么是"一步"而不是整条流：生成器首个 yield 之前的工作（AI 上下文采集、
   * 建议落库）会经 DRIZZLE_DATABASE 走 RLS，需要 org GUC；但 LLM 的网络等待
   * 发生在增量步之间——只包需要 DB 的那一步，才能避免一条连接被占满整条流
   * （连接池 max=20，20 个并发问答即可打满 DB_POOL_MAX）。
   */
  private async advanceStreamStep<T>(
    iterator: AsyncIterator<T>,
    context?: OrgContext,
  ): Promise<IteratorResult<T>> {
    const settings = this.streamTenantSettings(context);
    if (!settings) {
      return iterator.next();
    }
    return this.requestDatabaseContext.runInTransaction(settings, () =>
      iterator.next(),
    );
  }

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
   *
   * @StreamingResponse()：本端点手写 @Res() 且 for await 整条 LLM 流，若被
   * OrgContextInterceptor 包进请求级事务，一条 DB 连接会被占满整条流（见
   * org-context.interceptor.ts 的豁免分支）。建立步在下面显式补租户短事务。
   */
  @Post('chat')
  @StreamingResponse()
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
      // 手动推进生成器（不用 for await 整条跑）：只有"建立步"要进租户短事务——
      // collectSystemContext 的 3 个 RLS 读在首个 yield 之前执行，没有 org GUC
      // 会静默读空（AI 实时上下文凭空变成"暂无实时数据"）。之后的 LLM 增量步
      // 一律不持有事务/连接，长回答不再压住连接池。
      const stream = this.aiService
        .chatWithContextStream(question, orgId)
        [Symbol.asyncIterator]();
      try {
        let step = await this.advanceStreamStep(stream, request?.userContext);
        while (!step.done) {
          const chunk = step.value;
          // AI 助手增强（2026-08-19）：thinking 模型思考链独立事件 {reasoning}，
          // 正文增量事件 {delta}——前端分别渲染（思考区 + 打字机）。
          if (chunk.reasoning) {
            res.write(`data: ${JSON.stringify({ reasoning: chunk.reasoning })}\n\n`);
          }
          if (chunk.delta) {
            answer += chunk.delta;
            res.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`);
          }
          step = await stream.next();
        }
      } finally {
        // for await 会在提前退出（写响应失败/客户端断开）时自动 return() 掉生成器；
        // 改成手写推进后必须显式补上——否则内层 Ark 流的 reader 不解锁
        // （ark.service chatStream 的 finally { reader.releaseLock() }），
        // 出站连接会一直悬到对端自己结束。
        if (typeof stream.return === 'function') {
          await stream.return().catch(() => undefined);
        }
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
  async snapshotVersion(@Req() request?: { userContext?: OrgContext }) {
    // ADR-078 + R2-SMI-006：版本号按本租户聚合（跨租户混读关闭）；
    // 非 global_admin 且 org 缺失 fail-closed 401。
    const orgId = requireOrgScope(request?.userContext);
    // AI 接入修复（2026-08-18）：getSnapshotVersion 缺 await → Promise 序列化
    // 为 {}（AI 决策中心快照版本号显示异常）。
    return { version: await this.aiService.getSnapshotVersion(orgId) };
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

  /** AI 接入优化（2026-08-18）：建议生成流式版——骨架先出 → LLM 打字机 → done 落库。
   * 与 /api/ai/chat 同款 SSE 协议（data: {phase:…} 增量）。
   *
   * @StreamingResponse()：同 /chat，避免被包进请求级长事务；但本端点的租户事务
   * 无法只包 DB 部分（见下方注释），故由端点显式自持。
   */
  @Post('suggestions/stream')
  @StreamingResponse()
  async suggestionStream(
    @Body()
    body: {
      triggeredBy: string;
      problem: string;
      snapshot: { version: number; from: string; to: string; records: number };
    },
    @Res() res: Response,
    @Req() request: { userContext?: OrgContext; on?: (event: string, listener: () => void) => void },
  ) {
    if (!body.triggeredBy?.trim() || !body.problem?.trim()) {
      res.status(400).json({ phase: 'done', error: 'triggeredBy and problem are required' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // P2（2026-08-19 审计）：客户端断开取消（同 /chat，透传至出站 fetch）。
    const abort = new AbortController();
    const onClientClose = () => abort.abort();
    request?.on?.('close', onClientClose);
    const drive = async () => {
      for await (const evt of this.aiService.streamSuggestion({
        ...body,
        orgId: request.userContext?.primaryOrgId?.trim() || '',
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
    };
    try {
      // 本端点的落库在流末尾：ai.service streamSuggestion 的
      // attachRuleBasisInference + persistSuggestion 与最后一次 LLM 网络等待在同一个
      // 生成器步里，无法像 /chat 那样"只包建立步"（DB 与 LLM 尾步不可分，而在
      // ai.service 之外拿不到拆分点）。RLS 下无 org GUC 会直接拒绝该 INSERT
      // （不是降级读空），所以这里显式自持一个租户事务跑完整条流。
      // 豁免的只是拦截器的"隐式长事务"（决策权回到端点，见 org-context.interceptor.ts），
      // 租户收敛不受影响。后续把落库从 LLM 流里剥离（ai.service）后，这里可退化成短事务。
      const settings = this.streamTenantSettings(request.userContext);
      if (settings) {
        await this.requestDatabaseContext.runInTransaction(settings, drive);
      } else {
        await drive();
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      res.write(`data: ${JSON.stringify({ phase: 'done', error: message })}\n\n`);
    } finally {
      res.end();
    }
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
    // NEST-430 二轮收敛（R2）+ AI 接入修复（R3，2026-08-18）：
    // - 非空 image_url 仅放行固定边缘平台域（或 VISION_IMAGE_URL_ALLOWLIST 配置域），
    //   其余一律 400（SSRF 面收敛）；
    // - 空 image_url = 连通性测试：边缘平台侧使用演示默认图（无需用户提供外部图），
    //   修复此前"测试连接"必 400（前端默认不填图片 URL）。
    if (body.image_url && !visionImageUrlAllowed(body.image_url)) {
      throw new BadRequestException(
        'image_url 仅允许边缘平台（或 VISION_IMAGE_URL_ALLOWLIST 配置）域内的图片地址',
      );
    }
    // AI 接入修复：转发携带边缘平台服务账号 token（此前缺失 → 401 → 前端连接失败）。
    const edgeToken = await getEdgePlatformToken();
    const res = await fetch(`${EDGE_PLATFORM_URL}/api/vision/understand`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${edgeToken}`,
      },
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
