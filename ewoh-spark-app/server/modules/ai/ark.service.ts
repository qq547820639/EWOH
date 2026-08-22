import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql, eq, and, desc } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';
import { validateReasoningResult } from '@shared/reasoning-result';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AI_GLOBAL_ORG_SENTINEL } from '@server/common/org-sentinels';

/**
 * Ark 大模型通用客户端（文本对话）。
 *
 * 全局配置来源（优先级从高到低）：
 *   1. 系统配置表 ewoh_scheduler_config 中的 `ai.provider.ark`（由系统设置页写入）；
 *   2. 环境变量 EWOH_ARK_API_KEY / EWOH_ARK_BASE_URL / EWOH_ARK_MODEL；
 *   3. 内置默认值。
 *
 * 所有需要真实调用大模型的功能（AI 决策、大脑建议、自然语言问答）统一走本服务，
 * 保证"系统级别共享同一份 AI 配置"。
 *
 * v0.7 修复（AI 接入坏掉根因）：
 *   - 旧 saveConfig 未提供 org_id 列 → 写入 org_id=NULL；
 *     PostgreSQL 中 NULL 在唯一索引里彼此不相等 → ON CONFLICT (org_id, config_key)
 *     永不触发 → 每次保存都 INSERT 新行、从不 UPDATE → 读取 limit 1 可能拿到旧行/空行。
 *   - 修复：显式写入全局哨兵 org_id（GLOBAL_ORG_SENTINEL，固定 UUID），
 *     ON CONFLICT 恢复正常 upsert 语义；getConfig 按哨兵 + config_key 精确读取。
 */
export const ARK_CONFIG_KEY = 'ai.provider.ark';

/** 全局配置哨兵 org_id：AI 配置为系统级共享（不按租户隔离），
 *  用固定 UUID 占位而非 NULL，保证唯一索引与 ON CONFLICT 正常工作。 */
export const GLOBAL_ORG_SENTINEL = '00000000-0000-0000-0000-000000000000';

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seed-2-1-pro-260628';

export interface ArkConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ArkChatResult {
  ok: boolean;
  text: string;
  model: string;
  error?: string;
  /**
   * NO-08d（ADR-014）：Canonical ReasoningResult 元数据（含契约自检
   * contract_violations 留痕）。旧字段（ok/text/model/error）兼容保留。
   */
  reasoning?: Record<string, unknown>;
}

@Injectable()
export class ArkService {
  private readonly logger = new Logger(ArkService.name);

  constructor(
    @Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: PostgresJsDatabase,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * NO-08d（ADR-014）：把 Ark 文本结果包裹为 Canonical ReasoningResult。
   * confidence 必须 null（LLM 无标定置信度，禁止伪造）；契约自检失败 →
   * error 日志 + contract_violations 留痕（绝不静默）。
   */
  private buildReasoningResult(
    result: { ok: boolean; text: string; model: string; error?: string },
    kind: 'chat' | 'suggestion' | 'analysis',
    inputVersion: string,
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {
      reasoningId: `RS-${randomUUID().slice(0, 8)}`,
      level: kind === 'chat' ? 'L5_agentic_workflow' : 'L4_industrial_reasoning',
      kind,
      modelId: 'ark-chat',
      modelVersion: result.model || 'unversioned',
      inputVersion,
      subjectId: null,
      content: result.text,
      ok: result.ok,
      error: result.error ?? null,
      confidence: null,
      confidenceBasis: 'uncalibrated',
      evidence: { generatedAt: new Date().toISOString() },
    };
    const violations = validateReasoningResult(record);
    if (violations.length > 0) {
      this.logger.error(
        `reasoning result contract violations: ${violations.join(', ')}`,
      );
    }
    return { ...record, contract_violations: violations };
  }

  /** 读取全局 AI 配置（系统配置表 > 环境变量 > 默认值）。 */
  async getConfig(): Promise<ArkConfig> {
    let dbKey = '';
    let dbBase = '';
    let dbModel = '';
    if (this.db) {
      try {
        // v0.7 修复：按全局哨兵 org_id + config_key 精确读取（旧版无 org 过滤 + 无排序，
        // NULL 行 + limit 1 会读到不确定的旧行/空行）。
        // ADR-079：drizzle 类型安全（raw SQL 完整清零）。
        const rows = await this.db
          .select({ configValue: ewohSchedulerConfig.configValue })
          .from(ewohSchedulerConfig)
          .where(
            and(
              eq(ewohSchedulerConfig.configKey, ARK_CONFIG_KEY),
              eq(ewohSchedulerConfig.orgId, GLOBAL_ORG_SENTINEL),
            ),
          )
          .orderBy(desc(ewohSchedulerConfig.updatedAt))
          .limit(1);
        const row = rows?.[0];
        if (row?.configValue && typeof row.configValue === 'object') {
          const value = row.configValue as Record<string, unknown>;
          dbKey = String(value.api_key ?? '');
          dbBase = String(value.base_url ?? '');
          dbModel = String(value.model ?? '');
        }
      } catch {
        // 配置表读取失败时回落到环境变量
      }
    }
    const envKey = process.env.EWOH_ARK_API_KEY ?? '';
    const envBase = process.env.EWOH_ARK_BASE_URL ?? '';
    const envModel = process.env.EWOH_ARK_MODEL ?? '';
    return {
      apiKey: dbKey || envKey,
      baseUrl: dbBase || envBase || DEFAULT_BASE_URL,
      model: dbModel || envModel || DEFAULT_MODEL,
    };
  }

  /** 是否已配置可用的 API Key。 */
  async isConfigured(): Promise<boolean> {
    const cfg = await this.getConfig();
    return Boolean(cfg.apiKey);
  }

  /**
   * 保存全局 AI 配置到系统配置表（供所有系统功能共享）。
   * NEST-414/439：配置变更（含密钥/base_url）写审计日志——密钥字段不落明文，
   * 仅记录变更布尔；updatedBy 取操作者（不再硬编码 'system-admin'）。
   */
  async saveConfig(
    input: { api_key?: string; base_url?: string; model?: string },
    actor?: OrgContext,
  ): Promise<ArkConfig> {
    if (!this.db) {
      throw new Error('无数据库连接，无法持久化 AI 配置');
    }
    const current = await this.getConfig();
    const next = {
      api_key: input.api_key?.trim() || current.apiKey,
      base_url: input.base_url?.trim() || current.baseUrl,
      model: input.model?.trim() || current.model,
    };
    const updatedBy = actor?.userId ?? 'system-admin';
    // v0.7 修复：显式提供 org_id（全局哨兵）而非依赖列默认值（默认可能为 NULL）。
    // 旧版未写 org_id → NULL → ON CONFLICT (org_id, config_key) 永不冲突 → 无限插入新行。
    await this.db
      .insert(ewohSchedulerConfig)
      .values({
        orgId: GLOBAL_ORG_SENTINEL,
        configKey: ARK_CONFIG_KEY,
        configValue: next as unknown as Record<string, unknown>,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: [ewohSchedulerConfig.orgId, ewohSchedulerConfig.configKey],
        set: {
          configValue: next as unknown as Record<string, unknown>,
          updatedBy,
          updatedAt: new Date(),
        },
      });
    // NEST-414：审计留痕（密钥变更 risk:true；绝不记录密钥本值）。
    const apiKeyChanged = Boolean(input.api_key?.trim()) && input.api_key?.trim() !== current.apiKey;
    const baseUrlChanged = Boolean(input.base_url?.trim()) && input.base_url?.trim() !== current.baseUrl;
    try {
      await this.auditService?.appendAuditLog({
        actorId: updatedBy,
        orgId: actor?.primaryOrgId ?? GLOBAL_ORG_SENTINEL,
        action: 'ai.config.save',
        entityType: 'ai_provider_config',
        entityId: ARK_CONFIG_KEY,
        before: { apiKeyConfigured: Boolean(current.apiKey), baseUrl: current.baseUrl, model: current.model },
        after: { apiKeyConfigured: Boolean(next.api_key), baseUrl: next.base_url, model: next.model },
        risk: apiKeyChanged || baseUrlChanged,
        metadata: { apiKeyChanged, baseUrlChanged },
      });
    } catch (err) {
      this.logger.error(`AI 配置审计落账失败: ${String(err)}`);
    }
    return { apiKey: next.api_key, baseUrl: next.base_url, model: next.model };
  }

  private extractText(raw: unknown): string {
    const data = raw as { choices?: Array<{ message?: { content?: unknown } }> };
    const choices = data?.choices ?? [];
    if (!choices.length) return '';
    const content = choices[0].message?.content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === 'object' && c && (c as { type?: string }).type === 'text' ? (c as { text?: string }).text ?? '' : ''))
        .filter(Boolean)
        .join('\n');
    }
    return String(content ?? '');
  }

  /** 通用聊天：调用 Ark Chat Completions 文本对话。 */
  async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      /** NO-08d（ADR-014）：ReasoningResult kind（缺省 chat）。 */
      kind?: 'chat' | 'suggestion' | 'analysis';
      /** NO-08d（ADR-014）：输入版本（提示词 schema 版本，缺省 chat-v1）。 */
      inputVersion?: string;
    } = {},
  ): Promise<ArkChatResult> {
    const kind = opts.kind ?? 'chat';
    const inputVersion = opts.inputVersion ?? 'chat-v1';
    const finish = (r: {
      ok: boolean;
      text: string;
      model: string;
      error?: string;
    }): ArkChatResult => ({
      ok: r.ok,
      text: r.text,
      model: r.model,
      ...(r.error ? { error: r.error } : {}),
      reasoning: this.buildReasoningResult(r, kind, inputVersion),
    });
    const cfg = await this.getConfig();
    if (!cfg.apiKey) {
      return finish({
        ok: false,
        text: '',
        model: cfg.model,
        error: '未配置 Ark API Key（可在 系统管理 → AI 能力接入 中配置，或设置 EWOH_ARK_API_KEY）。',
      });
    }
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300000),
      });
    } catch (e) {
      return finish({ ok: false, text: '', model: cfg.model, error: `请求失败: ${String(e)}` });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return finish({ ok: false, text: '', model: cfg.model, error: `HTTP ${res.status}: ${detail.slice(0, 500)}` });
    }
    const raw = await res.json().catch(() => null);
    const text = this.extractText(raw);
    if (!text) {
      return finish({ ok: false, text: '', model: cfg.model, error: '模型未返回文本内容。' });
    }
    return finish({ ok: true, text, model: cfg.model });
  }

  /**
   * 流式聊天：调用 Ark Chat Completions（stream:true），逐增量产出文本。
   * 返回 AsyncGenerator<string>，每次 yield 一段新增文本。
   * 错误（未配置/网络/HTTP）在首个 yield 前以 throw 抛出，由调用方处理。
   *
   * P2（2026-08-19 审计）：opts.signal 支持调用方取消（客户端 SSE 断开时
   * 中止出站 fetch——此前 LLM 调用持续跑到自然结束，白白消耗配额与连接）。
   * abort 后在途 read 以 AbortError 结束，生成器正常收尾（不向上抛）。
   */
  async *chatStream(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<{ text?: string; reasoning?: string }, void, undefined> {
    const cfg = await this.getConfig();
    if (!cfg.apiKey) {
      throw new Error(
        '未配置 Ark API Key（可在 系统管理 → AI 能力接入 中配置，或设置 EWOH_ARK_API_KEY）。',
      );
    }
    if (opts.signal?.aborted) {
      return; // 调用方已取消（连接未建立前零成本退出）
    }
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      stream: true,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    // 超时 + 调用方取消合并为同一中止源。
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 300000);
    const signal = opts.signal
      ? AbortSignal.any([timeoutSignal, opts.signal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) return; // 调用方取消：静默收尾
      throw new Error(`请求失败: ${String(e)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    if (!res.body) {
      throw new Error('模型未返回可读流。');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }> };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // 忽略无法解析的分片
          }
          if (opts.signal?.aborted) return; // 取消：不再解析产出
          const choiceDelta = chunk.choices?.[0]?.delta;
          // AI 助手增强（2026-08-19）：thinking 模型（deepseek-v4-flash 等）在
          // delta.reasoning_content 输出思考链——与正文分开流式透传，前端展示思考区。
          const reasoningRaw = choiceDelta?.reasoning_content;
          if (reasoningRaw !== undefined && reasoningRaw !== null) {
            const reasoning = this.extractDeltaText(reasoningRaw);
            if (reasoning) yield { reasoning };
          }
          const text = this.extractDeltaText(choiceDelta?.content);
          if (text) yield { text };
        }
      }
    } catch (e) {
      // 取消导致的在途 read 中止：静默收尾（调用方已断开，无消费者）。
      if (opts.signal?.aborted) return;
      throw e;
    } finally {
      // fetch signal 已随 abort 撕断下载流，这里只需释放 reader 锁。
      reader.releaseLock();
    }
  }

  private extractDeltaText(delta: unknown): string {
    if (typeof delta === 'string') return delta;
    if (Array.isArray(delta)) {
      return delta
        .map((c) =>
          typeof c === 'object' && c && (c as { type?: string }).type === 'text'
            ? (c as { text?: string }).text ?? ''
            : '',
        )
        .join('');
    }
    return '';
  }

  /** 便捷方法：系统提示 + 用户问题。 */
  async ask(
    systemPrompt: string,
    userPrompt: string,
    opts: {
      temperature?: number;
      kind?: 'chat' | 'suggestion' | 'analysis';
      inputVersion?: string;
    } = {},
  ): Promise<ArkChatResult> {
    return this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      opts,
    );
  }
}