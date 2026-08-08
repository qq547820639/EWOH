import { Injectable, Inject, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { sql, eq } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';

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
}

@Injectable()
export class ArkService {
  constructor(@Optional() @Inject(DRIZZLE_DATABASE) private readonly db?: any) {}

  /** 读取全局 AI 配置（系统配置表 > 环境变量 > 默认值）。 */
  async getConfig(): Promise<ArkConfig> {
    let dbKey = '';
    let dbBase = '';
    let dbModel = '';
    if (this.db) {
      try {
        // v0.7 修复：按全局哨兵 org_id + config_key 精确读取（旧版无 org 过滤 + 无排序，
        // NULL 行 + limit 1 会读到不确定的旧行/空行）。
        const rows = await this.db.execute(
          sql`
            select config_value from public.ewoh_scheduler_config
            where config_key = ${ARK_CONFIG_KEY}
              and org_id = ${GLOBAL_ORG_SENTINEL}::uuid
            order by _updated_at desc
            limit 1
          `,
        );
        const row = rows?.[0];
        if (row?.config_value && typeof row.config_value === 'object') {
          const value = row.config_value as Record<string, unknown>;
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

  /** 保存全局 AI 配置到系统配置表（供所有系统功能共享）。 */
  async saveConfig(input: { api_key?: string; base_url?: string; model?: string }): Promise<ArkConfig> {
    if (!this.db) {
      throw new Error('无数据库连接，无法持久化 AI 配置');
    }
    const current = await this.getConfig();
    const next = {
      api_key: input.api_key?.trim() || current.apiKey,
      base_url: input.base_url?.trim() || current.baseUrl,
      model: input.model?.trim() || current.model,
    };
    // v0.7 修复：显式提供 org_id（全局哨兵）而非依赖列默认值（默认可能为 NULL）。
    // 旧版未写 org_id → NULL → ON CONFLICT (org_id, config_key) 永不冲突 → 无限插入新行。
    await this.db.execute(
      sql`
        insert into public.ewoh_scheduler_config (org_id, config_key, config_value, updated_by)
        values (${GLOBAL_ORG_SENTINEL}::uuid, ${ARK_CONFIG_KEY}, ${JSON.stringify(next)}::jsonb, 'system-admin')
        on conflict (org_id, config_key)
        do update set config_value = excluded.config_value, updated_by = excluded.updated_by, _updated_at = now()
      `,
    );
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
    opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
  ): Promise<ArkChatResult> {
    const cfg = await this.getConfig();
    if (!cfg.apiKey) {
      return {
        ok: false,
        text: '',
        model: cfg.model,
        error: '未配置 Ark API Key（可在 系统管理 → AI 能力接入 中配置，或设置 EWOH_ARK_API_KEY）。',
      };
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
      return { ok: false, text: '', model: cfg.model, error: `请求失败: ${String(e)}` };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, text: '', model: cfg.model, error: `HTTP ${res.status}: ${detail.slice(0, 500)}` };
    }
    const raw = await res.json().catch(() => null);
    const text = this.extractText(raw);
    if (!text) {
      return { ok: false, text: '', model: cfg.model, error: '模型未返回文本内容。' };
    }
    return { ok: true, text, model: cfg.model };
  }

  /** 便捷方法：系统提示 + 用户问题。 */
  async ask(systemPrompt: string, userPrompt: string, opts: { temperature?: number } = {}): Promise<ArkChatResult> {
    return this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      opts,
    );
  }
}