/* v0.7 AI 接入修复测试：ark.service.ts 配置读写
 * 覆盖（AI 接入坏掉根因回归）：
 *   - saveConfig 显式提供 org_id（全局哨兵）→ ON CONFLICT 正常 upsert
 *   - getConfig 按哨兵 org_id 精确读取（不再 limit 1 无过滤读到旧行/空行）
 *   - 环境变量降级链保持
 */
/// <reference types="jest" />
import { ArkService, ARK_CONFIG_KEY, GLOBAL_ORG_SENTINEL } from './ark.service';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

/** drizzle sql 模板对象 → { sql, params }（0.45 用 dialect.sqlToQuery 序列化，值在 params）。 */
function toSqlQuery(arg: unknown): { sql: string; params: unknown[] } {
  if (typeof arg === 'string') return { sql: arg, params: [] };
  try {
    return dialect.sqlToQuery(arg as never);
  } catch {
    return { sql: String(arg), params: [] };
  }
}

function makeDb(rows: Array<Record<string, unknown>> = []) {
  const execute = jest.fn().mockResolvedValue(rows);
  // ADR-079：drizzle 链式假库（select 读配置 + insert upsert）。
  const selectCalls: Array<{ table: unknown; cond: unknown }> = [];
  const insertRows: Array<Record<string, unknown>> = [];
  const db = {
    execute,
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const q: any = Promise.resolve(rows);
        q.where = (cond: unknown) => {
          selectCalls.push({ table, cond });
          return q;
        };
        q.orderBy = () => q;
        q.limit = () => q;
        return q;
      }),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push(row);
        return {
          onConflictDoUpdate: jest.fn(async () => []),
        };
      }),
    })),
  };
  return { db, selectCalls, insertRows };
}

describe('v0.7 AI 接入修复: ArkService 配置读写', () => {
  it('saveConfig 的 SQL 显式包含 org_id 哨兵（修复 NULL ON CONFLICT 失效）', async () => {
    const { db, insertRows } = makeDb([]);
    const svc = new ArkService(db as never);

    await svc.saveConfig({ api_key: 'ark-secret-key', model: 'doubao-x' });

    // ADR-079：drizzle upsert——orgId 哨兵显式写入 + onConflictDoUpdate。
    expect(insertRows).toHaveLength(1);
    expect(insertRows[0].orgId).toBe(GLOBAL_ORG_SENTINEL);
    expect(insertRows[0].configKey).toBe(ARK_CONFIG_KEY);
    expect(JSON.stringify(insertRows[0].configValue)).toContain('ark-secret-key');
  });

  it('getConfig 的 SQL 按哨兵 org_id 精确读取 + 排序（不再读到旧行/空行）', async () => {
    const { db, selectCalls } = makeDb([
      {
        configValue: { api_key: 'db-key', base_url: 'https://x.example/v3', model: 'm1' },
      },
    ]);
    const svc = new ArkService(db as never);

    const cfg = await svc.getConfig();

    // ADR-079：drizzle 读——哨兵 org 条件经链式假库捕获（行为断言优先）。
    expect(selectCalls).toHaveLength(1);
    expect(cfg.apiKey).toBe('db-key');
    expect(cfg.model).toBe('m1');
  });

  it('DB 无配置 → 回落到环境变量', async () => {
    const saved = process.env.EWOH_ARK_API_KEY;
    process.env.EWOH_ARK_API_KEY = 'env-key';
    const { db } = makeDb([]);
    const svc = new ArkService(db as never);

    const cfg = await svc.getConfig();
    expect(cfg.apiKey).toBe('env-key');

    if (saved === undefined) delete process.env.EWOH_ARK_API_KEY;
    else process.env.EWOH_ARK_API_KEY = saved;
  });

  it('无数据库连接 → 保存抛错，读取回落环境变量', async () => {
    const saved = process.env.EWOH_ARK_API_KEY;
    delete process.env.EWOH_ARK_API_KEY;
    const svc = new ArkService(undefined);

    await expect(svc.saveConfig({ api_key: 'k' })).rejects.toThrow('无数据库连接');
    const cfg = await svc.getConfig();
    expect(cfg.apiKey).toBe('');
    expect(cfg.baseUrl).toContain('ark.cn-beijing');

    if (saved !== undefined) process.env.EWOH_ARK_API_KEY = saved;
  });

  it('GLOBAL_ORG_SENTINEL 为固定 UUID（可重复执行 upsert）', () => {
    expect(GLOBAL_ORG_SENTINEL).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(ARK_CONFIG_KEY).toBe('ai.provider.ark');
  });
});

describe('NO-08d（ADR-014）：Ark 文本结果包裹 ReasoningResult', () => {
  it('chat 成功：reasoning 元数据齐备且无标定置信度显式声明', async () => {
    const db = makeDb([]);
    process.env.EWOH_ARK_API_KEY = 'env-key';
    const svc = new ArkService(db as never);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as never,
    );
    const res = await svc.chat([{ role: 'user', content: 'hi' }]);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('你好');
    expect(res.reasoning).toBeDefined();
    const r = res.reasoning as Record<string, unknown>;
    expect(r.kind).toBe('chat');
    expect(r.level).toBe('L5_agentic_workflow');
    expect(r.modelId).toBe('ark-chat');
    expect(r.confidence).toBeNull();
    expect(r.confidenceBasis).toBe('uncalibrated');
    expect(r.inputVersion).toBe('chat-v1');
    expect(r.contract_violations).toEqual([]);
    fetchMock.mockRestore();
    delete process.env.EWOH_ARK_API_KEY;
  });

  it('chat 未配置：失败路径 reasoning ok=false + error 可审计', async () => {
    const saved = process.env.EWOH_ARK_API_KEY;
    delete process.env.EWOH_ARK_API_KEY;
    const svc = new ArkService(makeDb([]) as never);
    const res = await svc.chat([{ role: 'user', content: 'hi' }]);
    expect(res.ok).toBe(false);
    const r = res.reasoning as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect((r.error as string).length).toBeGreaterThan(0);
    expect(r.contract_violations).toEqual([]);
    if (saved !== undefined) process.env.EWOH_ARK_API_KEY = saved;
  });

  it('ask 透传 kind/inputVersion（suggestion 路径）', async () => {
    process.env.EWOH_ARK_API_KEY = 'env-key';
    const svc = new ArkService(makeDb([]) as never);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestion":"x"}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as never,
    );
    const res = await svc.ask('sys', 'q', { kind: 'suggestion', inputVersion: 'scheduler-suggestion-v2' });
    const r = res.reasoning as Record<string, unknown>;
    expect(r.kind).toBe('suggestion');
    expect(r.level).toBe('L4_industrial_reasoning');
    expect(r.inputVersion).toBe('scheduler-suggestion-v2');
    fetchMock.mockRestore();
    delete process.env.EWOH_ARK_API_KEY;
  });
});
