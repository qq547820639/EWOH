/// <reference types="jest" />
/* 回归（FR4 对抗审查 2026-09-13）：getReplay 的实体类型映射查询必须带 org 谓词。
 *
 * 缺陷：getReplay 里把 world_state 的 entityId 映射到 spatial 实体类型的查询
 * （entityId → entityType，用于回放 persons/devices 分类）没有 org 过滤——
 * NEST-606 给五张事实表都补了 org 谓词，唯独漏了这一条。entityId 只在租户内
 * 唯一（uq (org_id, entity_id)），跨租户同号实体的类型可能不同（A 租户的
 * "ws-01" 是 person、B 租户的是 workstation），无谓词查询会把他租户的登记
 * 读进来：既是一次跨租户读，又可能把本租户实体错分进 persons/devices。
 */
/// <reference types="jest" />
import { WorldService } from '../world.service';

const ORG_A = 'org-a';

/** 收集 drizzle 条件对象里的字符串/数字叶子（Param.value / 字面量）。 */
function leafValues(cond: unknown): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new WeakSet<object>();
  (function walk(node: unknown) {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const el of node) walk(el);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') {
        out.push(value);
      } else {
        walk(value);
      }
    }
  })(cond);
  return out;
}

function createReplayDb() {
  const conds: Array<Array<string | number>> = [];
  const results: unknown[][] = [];
  const chain = {
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown[]) => void) => {
      resolve(results.shift() ?? []);
      return undefined as never;
    },
  };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          conds.push(leafValues(cond));
          return chain;
        }),
      })),
    })),
  };
  return { db, conds, results };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    primaryOrgId: ORG_A,
    isGlobalAdmin: false,
    ...overrides,
  };
}

describe('WorldService.getReplay：实体类型映射查询带 org 谓词', () => {
  it('最后一次查询（spatial 实体类型映射）的 where 必须包含本租户 org', async () => {
    const { db, conds, results } = createReplayDb();
    // getReplay 查询顺序：states → events → tasks → steps → materials → entityType
    results.push([
      {
        id: 'w1',
        entityId: 'p-1',
        stateJson: { x: 1, y: 2, status: 'active' },
        ts: new Date('2026-09-13T08:00:00Z'),
        orgId: ORG_A,
      },
    ]);
    results.push([]); // events
    results.push([]); // tasks
    results.push([]); // steps
    results.push([]); // materials
    results.push([]); // entityTypeById（本用例只验证谓词，不关心行）
    const service = new WorldService(db as never, {} as never);
    const snapshots = await service.getReplay(
      '2026-09-13T07:00:00Z',
      '2026-09-13T09:00:00Z',
      100,
      actor() as never,
    );
    expect(snapshots).toHaveLength(1);
    expect(conds.length).toBeGreaterThanOrEqual(6);
    // 最后一次捕获 = spatial 实体类型映射查询
    const lastCond = conds[conds.length - 1];
    expect(lastCond).toContain(ORG_A);
  });

  it('global_admin 显式放行（无 org 谓词，与 RLS 例外一致）', async () => {
    const { db, conds, results } = createReplayDb();
    results.push([]);
    results.push([]);
    results.push([]);
    results.push([]);
    results.push([]);
    results.push([]);
    const service = new WorldService(db as never, {} as never);
    await service.getReplay(
      '2026-09-13T07:00:00Z',
      '2026-09-13T09:00:00Z',
      100,
      actor({ isGlobalAdmin: true }) as never,
    );
    // admin 无 states 行 → 不触发 entityType 查询；谓词数量 = 5 条事实表查询
    expect(conds.length).toBe(5);
  });
});
