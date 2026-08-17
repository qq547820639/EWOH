/* P1：entity-aware trigger debounce 回归测试。
 *
 * 验证 TriggerService.evaluate 的冷却去抖已按 (orgId, triggerType, entityId) 判定：
 *  - 同实体同类型窗口内 → 去抖（返回 null，不创建 run）。
 *  - 不同实体同类型窗口内 → 不去抖（各自创建 run）。
 *  - 无实体（entityId=null）→ 退化为 orgId+triggerType 去抖（按 'ALL'）。
 *
 * NESP-119（2026-08-17）：NEST-147 后幂等去重不再走独立 SELECT（check-then-insert
 * 竞态）而是 INSERT ... ON CONFLICT (trigger_key) DO NOTHING——fake 的查询身份
 * 判别不再需要（唯一 SELECT 即冷却查询）；触发表 insert 模拟唯一键冲突语义
 * （同 triggerKey 已存在 → onConflictDoNothing 返回空行集 = 去重合并）。
 */
/// <reference types="jest" />
import { TriggerService } from '../trigger.service';
import { ewohReplanTrigger, ewohSchedulingRun } from '@server/database/schema';

/** 从 drizzle and(...)/eq(...) 结果中递归收集所有 Param 绑定值（用于断言 WHERE 条件维度）。 */
function collectEqValues(cond: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (x == null || typeof x !== 'object') return;
    const obj = x as Record<string, unknown>;
    // Param：绑定值（scalar value）；StringChunk.value 是数组，据此区分并跳过。
    const v = obj.value;
    if (
      (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') &&
      !Array.isArray(v)
    ) {
      out.push(String(v));
      return;
    }
    // SQL：递归 queryChunks。
    const chunks = obj.queryChunks;
    if (Array.isArray(chunks)) {
      chunks.forEach(walk);
    }
  };
  walk(cond);
  return out;
}

describe('P1 entity-aware trigger debounce', () => {
  /** 构造实体感知的 fake db：冷却查询按 entityId 过滤已插入的触发行。 */
  function makeEntityAwareDb() {
    const triggerRows: Array<Record<string, unknown>> = [];

    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn((cond: unknown) => {
            // NESP-119：唯一 SELECT 为冷却查询 and(orgId, triggerType, entityId)；
            // 幂等去重已并入 INSERT ON CONFLICT（NEST-147），无需按调用序/参数
            // 数量启发式区分查询身份。
            const vals = collectEqValues(cond);
            const entityId = vals.length >= 3 ? (vals[2] ?? 'ALL') : 'ALL';
            const limit = jest.fn(() => {
              // 模拟真实 entityId 过滤 + 最近一条（orderBy createdAt desc limit 1）。
              const recent = triggerRows
                .filter((r) => r.entityId === entityId)
                .sort(
                  (a, b) =>
                    (b.createdAt as Date).getTime() -
                    (a.createdAt as Date).getTime(),
                )[0];
              return Promise.resolve(recent ? [recent] : []);
            });
            return { orderBy: jest.fn(() => ({ limit })), limit };
          }),
        })),
      })),
      insert: jest.fn((table: unknown) => ({
        values: (values: unknown) => {
          if (table === ewohReplanTrigger) {
            const v = values as Record<string, unknown>;
            const conflict = triggerRows.some((r) => r.triggerKey === v.triggerKey);
            return {
              // NEST-147：幂等去重 = ON CONFLICT (trigger_key) DO NOTHING——
              // 已存在同键行 → 返回空行集（合并）；否则插入并返回新行。
              onConflictDoNothing: jest.fn(() => ({
                returning: jest.fn(() =>
                  conflict
                    ? Promise.resolve([])
                    : (triggerRows.push({ ...v, createdAt: new Date() }),
                      Promise.resolve([{ ...v }])),
                ),
              })),
              returning: jest.fn(() => {
                if (conflict) {
                  return Promise.reject(
                    Object.assign(
                      new Error('duplicate key value violates unique constraint'),
                      { code: '23505' },
                    ),
                  );
                }
                triggerRows.push({ ...v, createdAt: new Date() });
                return Promise.resolve([{ ...v }]);
              }),
            };
          }
          if (table === ewohSchedulingRun) {
            return {
              returning: () =>
                Promise.resolve([{ ...(values as Record<string, unknown>) }]),
            };
          }
          return Promise.resolve([]);
        },
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    };

    const requestDatabaseContext = {
      runInTransaction: jest.fn(
        async (_guc: unknown, fn: () => Promise<unknown>) => fn(),
      ),
    };
    const policyService = {
      getConfig: jest.fn().mockResolvedValue({ triggerCooldownMs: 30_000 }),
    };
    const svc = new TriggerService(
      db as never,
      requestDatabaseContext as never,
      policyService as never,
    );
    return { svc, db };
  }

  const ctx = { userId: 'u1', primaryOrgId: 'org1' };

  it('同实体同类型窗口内 → 去抖（返回 null，不创建 run）', async () => {
    const { svc, db } = makeEntityAwareDb();
    const first = await svc.evaluate('DEVICE_OFFLINE', 'd1', ctx);
    expect(first).not.toBeNull();
    // 冷却命中（同一实体 d1 最近触发）→ 第二次被合并。
    const second = await svc.evaluate('DEVICE_OFFLINE', 'd1', ctx);
    expect(second).toBeNull();
    // 第二次未新增任何插入（仅首次 2 次：trigger + run）。
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('不同实体同类型窗口内 → 不去抖（各自创建 run）', async () => {
    const { svc } = makeEntityAwareDb();
    const first = await svc.evaluate('DEVICE_OFFLINE', 'd1', ctx);
    expect(first).not.toBeNull();
    // 冷却查询按 entityId 过滤：d2 与 d1 不同，不命中 d1 的最近触发 → 创建独立 run。
    const second = await svc.evaluate('DEVICE_OFFLINE', 'd2', ctx);
    expect(second).not.toBeNull();
    expect(second!.runId).not.toBe(first!.runId);
  });

  it('无实体（entityId=null）→ 退化为 orgId+triggerType 去抖（按 ALL）', async () => {
    const { svc } = makeEntityAwareDb();
    const first = await svc.evaluate('DEADLINE_AT_RISK', null, ctx);
    expect(first).not.toBeNull();
    const second = await svc.evaluate('DEADLINE_AT_RISK', null, ctx);
    expect(second).toBeNull();
  });

  it('NEST-147：幂等去重走 INSERT ON CONFLICT（trigger_key 冲突 → 合并返回 null）', async () => {
    const { svc, db } = makeEntityAwareDb();
    const first = await svc.evaluate('ROUTE_BLOCKED', 'e1', ctx);
    expect(first).not.toBeNull();
    const second = await svc.evaluate('ROUTE_BLOCKED', 'e1', ctx);
    // 冷却与 ON CONFLICT 两条去重路径都不创建第二个 run（run insert 仍只有首次 1 次）。
    expect(second).toBeNull();
    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
