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
  return { execute };
}

describe('v0.7 AI 接入修复: ArkService 配置读写', () => {
  it('saveConfig 的 SQL 显式包含 org_id 哨兵（修复 NULL ON CONFLICT 失效）', async () => {
    const db = makeDb([]);
    const svc = new ArkService(db as never);

    await svc.saveConfig({ api_key: 'ark-secret-key', model: 'doubao-x' });

    const calls = db.execute.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2); // getConfig + saveConfig
    // 最后一条是 saveConfig 的 INSERT（drizzle sql 模板对象 → sqlToQuery 序列化，值在 params）
    const save = toSqlQuery(calls[calls.length - 1][0]);
    expect(save.sql).toContain('org_id');
    expect(save.sql).toContain('on conflict (org_id, config_key)');
    expect(save.sql).toContain('do update');
    // 哨兵 org_id 与 api_key 作为参数传递（占位符 $N）
    expect(save.params).toContain(GLOBAL_ORG_SENTINEL);
    expect(JSON.stringify(save.params)).toContain('ark-secret-key');
    // 关键断言：不再出现"未提供 org_id 的裸 INSERT"（旧 Bug 形态）
    expect(save.sql).not.toMatch(/insert into public\.ewoh_scheduler_config \(config_key, config_value, updated_by\)/);
  });

  it('getConfig 的 SQL 按哨兵 org_id 精确读取 + 排序（不再读到旧行/空行）', async () => {
    const db = makeDb([
      {
        config_value: { api_key: 'db-key', base_url: 'https://x.example/v3', model: 'm1' },
      },
    ]);
    const svc = new ArkService(db as never);

    const cfg = await svc.getConfig();

    const get = toSqlQuery(db.execute.mock.calls[0][0]);
    expect(get.sql).toContain('org_id = ');
    expect(get.sql).toContain('order by _updated_at desc');
    expect(get.sql).toContain('limit 1');
    expect(get.params).toContain(GLOBAL_ORG_SENTINEL);
    expect(cfg.apiKey).toBe('db-key');
    expect(cfg.model).toBe('m1');
  });

  it('DB 无配置 → 回落到环境变量', async () => {
    const saved = process.env.EWOH_ARK_API_KEY;
    process.env.EWOH_ARK_API_KEY = 'env-key';
    const db = makeDb([]);
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
