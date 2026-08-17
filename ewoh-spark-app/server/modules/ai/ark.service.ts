import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
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
    @Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: any,
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