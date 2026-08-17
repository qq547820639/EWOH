/* WorldService 租户隔离回归（R2-SNZ-001 / R2-SNZ-014，2026-08-17 审计整改）。
 *
 * R2-SNZ-001：getEventChain 必须带 org 谓词——原先任何认证用户持他租户
 * eventId 即可枚举该事件完整因果链；global_admin 显式放行；缺租户 400。
 * R2-SNZ-014：getReplay 的 events 查询必须有行数上限（原先唯一无 limit
 * 的查询，宽时间窗可全量拉取致内存膨胀）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { WorldService } from '../world.service';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

interface EventChainRow {
  id: number;
  eventId: string;
  parentEventId: string | null;
  orgId: string;
  causalType: string;
  description: string | null;
  createdAt: Date;
}

function chainRow(overrides: Partial<EventChainRow> = {}): EventChainRow {
  return {
    id: 1,
    eventId: 'evt-1',
    parentEventId: null,
    orgId: ORG_A,
    causalType: 'triggered',
    description: null,
    createdAt: new Date('2026-08-16T10:00:00Z'),
    ...overrides,
  };
}

/** 收集 drizzle 条件对象的字符串/数字叶子（Param.value）。 */
function leafValues(cond: unknown): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new WeakSet<object>();
  (function walk(node: unknown) {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const el of node) {
        // 嵌套 sql 模板的数字字面量以裸值出现在 chunks 数组（字符串裸值
        // 是 SQL 定界符如 "("，不可收集）。
        if (typeof el === 'number') out.push(el);
        else walk(el);
      }
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'value' && (typeof value === 'string' || typeof value === 'number')) {
        out.push(value);
      } else {
        walk(value);
      }
    }
  })(cond);
  return out;
}

function rowValueSet(row: Record<string, unknown>): Array<string | number> {
  return [
    String(row.id),
    String(row.eventId),
    row.parentEventId ? String(row.parentEventId) : '__null__',
    String(row.orgId),
  ];
}

function createWorldDb(rows: EventChainRow[]) {
  const calls: Array<{ whereLeaves: Array<string | number> }> = [];
  const queryChain = {
    orderBy: jest.fn(() => queryChain),
    limit: jest.fn(() => queryChain),
    then: (resolve: (v: unknown[]) => void) => {
      resolve(queryChain.resolved as unknown[]);
      return undefined as never;
    },
    resolved: [] as unknown[],
  };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          calls.push({ whereLeaves: leafValues(cond) });
          const leaves = leafValues(cond);
          queryChain.resolved = rows.filter((r) => {
            const vals = rowValueSet(r as unknown as Record<string, unknown>);
            return leaves.every((leaf) => vals.includes(String(leaf)));
          });
          return queryChain;
        }),
      })),
    })),
  };
  return { db, calls };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    primaryOrgId: ORG_A,
    roles: ['dispatcher'],
    isGlobalAdmin: false,
    ...overrides,
  };
}

describe('WorldService.getEventChain（R2-SNZ-001 租户谓词）', () => {
  it('本租户：以 eventId / parentEventId 命中的链节点均返回', async () => {
    const { db } = createWorldDb([
      chainRow({ id: 1, eventId: 'evt-1' }),
      chainRow({ id: 2, eventId: 'evt-2', parentEventId: 'evt-1' }),
    ]);
    const service = new WorldService(db as never, {} as never);
    const nodes = await service.getEventChain('evt-1', actor());
    expect(nodes).toHaveLength(2);
  });

  it('他租户 eventId：org 谓词过滤后不可见（返回空，而非跨租户枚举）', async () => {
    const { db } = createWorldDb([
      chainRow({ id: 1, eventId: 'evt-1', orgId: ORG_B }),
      chainRow({ id: 2, eventId: 'evt-2', parentEventId: 'evt-1', orgId: ORG_B }),
    ]);
    const service = new WorldService(db as never, {} as never);
    const nodes = await service.getEventChain('evt-1', actor());
    expect(nodes).toHaveLength(0);
  });

  it('缺租户上下文：fail-closed 400（不静默放行全租户）', async () => {
    const { db } = createWorldDb([]);
    const service = new WorldService(db as never, {} as never);
    await expect(
      service.getEventChain('evt-1', actor({ primaryOrgId: '  ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getEventChain('evt-1', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('global_admin：跨租户链节点可见（显式放行，与 RLS 例外一致）', async () => {
    const { db } = createWorldDb([
      chainRow({ id: 1, eventId: 'evt-1', orgId: ORG_B }),
    ]);
    const service = new WorldService(db as never, {} as never);
    const nodes = await service.getEventChain('evt-1', actor({ isGlobalAdmin: true }));
    expect(nodes).toHaveLength(1);
  });

  it('查询谓词包含 org 列值（防回归：无 org 条件的 where 不允许）', async () => {
    const { db, calls } = createWorldDb([]);
    const service = new WorldService(db as never, {} as never);
    await service.getEventChain('evt-1', actor());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.whereLeaves).toContain(ORG_A);
  });
});
