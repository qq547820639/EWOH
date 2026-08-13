/* P1：entity-aware trigger debounce 回归测试。
 *
 * 验证 TriggerService.evaluate 的冷却去抖已按 (orgId, triggerType, entityId) 判定：
 *  - 同实体同类型窗口内 → 去抖（返回 null，不创建 run）。
 *  - 不同实体同类型窗口内 → 不去抖（各自创建 run）。
 *  - 无实体（entityId=null）→ 退化为 orgId+triggerType 去抖（按 'ALL'）。
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
    let capturedEntityId: string | null = null;

    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn((cond: unknown) => {
            const vals = collectEqValues(cond);
            // 冷却查询：and(orgId, triggerType, entityId) → vals = [orgId, triggerType, entityId]
            // 幂等去重查询：eq(triggerKey) → vals = [orgId:triggerType:entityId:version]（含 ':'）
            const isCooldownQuery = vals.length >= 3;
            capturedEntityId = isCooldownQuery ? (vals[2] ?? 'ALL') : null;
            const limit = jest.fn(() => {
              if (isCooldownQuery) {
                // 模拟真实 entityId 过滤 + 最近一条（orderBy createdAt desc limit 1）。
                const recent = triggerRows
                  .filter((r) => r.entityId === capturedEntityId)
                  .sort(
                    (a, b) =>
                      (b.createdAt as Date).getTime() -
                      (a.createdAt as Date).getTime(),
                  )[0];
                return Promise.resolve(recent ? [recent] : []);
              }
              // 幂等去重：恒无已存在 triggerKey（同键重复由 insert 唯一约束兜底）。
              return Promise.resolve([]);
            });
            return { orderBy: jest.fn(() => ({ limit })), limit };
          }),
        })),
      })),
      insert: jest.fn((table: unknown) => ({
        values: (values: unknown) => {
          if (table === ewohReplanTrigger) {
            const v = values as Record<string, unknown>;
            if (triggerRows.some((r) => r.triggerKey === v.triggerKey)) {
              return Promise.reject(
                Object.assign(
                  new Error('duplicate key value violates unique constraint'),
                  { code: '23505' },
                ),
              );
            }
            triggerRows.push({ ...v, createdAt: new Date() });
            return Promise.resolve([]);
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
});
