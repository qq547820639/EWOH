/* WorldStateSnapshotService 快照版本分配（原子计数器）单元测试。
 *
 * 覆盖：
 *   1) 同日递增：计数器 upsert 返回 last_seq 1 → WS-YYYYMMDD-0001，再 2 → -0002；
 *   2) 跨日回卷：WS-<d1>-0001 → WS-<d2>-0001（day 参数随日期切换）；
 *   3) 唯一冲突（23505）→ 有界重试：首次插入失败、二次以全新版本成功；
 *   4) 超过 MAX_ATTEMPTS（3）次冲突 → 抛明确错误（绝不无限循环）。
 *
 * 复用 fake-db 模式（world-state-derive.spec.ts 同款）：构造最小 drizzle 链，
 * 模拟 collectState 的空表读取 + 计数器 execute + 快照 insert。
 */
/// <reference types="jest" />
import { WorldStateSnapshotService } from '../world-state.service';
import {
  ewohResourceReservation,
  ewohDeviceBinding,
} from '@server/database/schema';
import type { OrgContext } from '../../shared/org-context.interceptor';

/** 与服务 dateStamp 相同的本地日期戳逻辑（YYYYMMDD）。 */
function localStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 从 drizzle sql 模板对象中提取参数值（StringChunk 为静态文本跳过，其余取值）。 */
function sqlParams(query: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (chunk: unknown): void => {
    if (typeof chunk === 'string' || typeof chunk === 'number') {
      out.push(chunk); // 插值参数（裸值 chunk）
      return;
    }
    if (chunk && typeof chunk === 'object') {
      const obj = chunk as Record<string, unknown>;
      if (Array.isArray(obj.queryChunks)) {
        for (const sub of obj.queryChunks as unknown[]) visit(sub);
        return;
      }
      if (Array.isArray(obj.value)) return; // StringChunk：静态文本
      if ('value' in obj) {
        out.push(obj.value); // Param / Name
      }
    }
  };
  visit(query);
  return out;
}

interface FakeDb {
  select: jest.Mock;
  insert: jest.Mock;
  execute: jest.Mock;
}

function makeDb(): FakeDb {
  const emptyResult: any = Promise.resolve([]);
  emptyResult.orderBy = () => emptyResult;
  emptyResult.limit = () => emptyResult;
  const fromResult: any = Promise.resolve([]);
  fromResult.where = () => emptyResult;
  fromResult.orderBy = () => fromResult;
  fromResult.limit = () => fromResult;
  const select = jest.fn(() => ({
    from: jest.fn(() => fromResult),
  }));
  const execute = jest.fn().mockResolvedValue([{ last_seq: 1 }]);
  const values = jest.fn().mockResolvedValue(undefined);
  const insert = jest.fn(() => ({ values }));
  return { select, insert, execute };
}

function makeSvc(db: FakeDb) {
  const runInTransaction = jest.fn(
    (_settings: unknown, op: () => Promise<unknown>) => op(),
  );
  const svc = new WorldStateSnapshotService(
    db as never,
    { runInTransaction } as never,
    {
      projectForSnapshot: jest.fn().mockResolvedValue({
        persons: [],
        devices: [],
        stations: [],
      }),
    } as never,
  );
  return { svc, runInTransaction, insertValues: db.insert().values as jest.Mock, execute: db.execute };
}

const ctx: OrgContext = {
  userId: 'u-version-test',
  primaryOrgId: 'org-version-test',
  accessibleOrgIds: ['org-version-test'],
  isGlobalAdmin: false,
};

describe('WorldStateSnapshotService: 实体版本哈希（fnv1a48）契约', () => {
  it('哈希必须恒为非负安全整数（世界快照契约 entityVersions 值 ≥ 0）', () => {
    // 2026-09-19 实测：旧实现 (h1>>>0) * 2^32 超出 2^53 精度丢失，
    // 且 & 0xFFFFFFFFFFFF 经 ToInt32 截断为有符号 32 位——约 50% 概率产出
    // 负数（持久化快照 158 个 entityVersions 中 69 个为负，契约自检
    // bad_entity_version_value 告警）。本用例以大量输入钉死该契约。
    const fnv1a48 = (WorldStateSnapshotService as unknown as {
      fnv1a48: (str: string) => number;
    }).fnv1a48;
    expect(typeof fnv1a48).toBe('function');
    const kinds = ['person', 'device', 'station', 'route', 'task', 'event', 'reservation'];
    for (let i = 0; i < 2000; i++) {
      const key = `${kinds[i % kinds.length]}:ENTITY-${i}`;
      const v = fnv1a48(key);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
    // 确定性：同输入同输出（plan-staleness 比较依赖该性质）。
    expect(fnv1a48('station:NODE-LA-02')).toBe(fnv1a48('station:NODE-LA-02'));
  });
});

describe('WorldStateSnapshotService: 快照版本原子分配（ewoh_snapshot_version_counter）', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('同日递增：计数器 last_seq 1 → WS-<today>-0001，再 2 → -0002（同一事务内分配+插入）', async () => {
    const db = makeDb();
    const { svc, execute, insertValues } = makeSvc(db);
    execute.mockReset();
    execute
      .mockResolvedValueOnce([{ last_seq: 1 }])
      .mockResolvedValueOnce([{ last_seq: 2 }]);

    const today = localStamp(new Date());
    const s1 = await svc.buildSnapshot(ctx);
    const s2 = await svc.buildSnapshot(ctx);

    expect(s1.snapshotVersion).toBe(`WS-${today}-0001`);
    expect(s2.snapshotVersion).toBe(`WS-${today}-0002`);
    // 计数器 upsert 携带当天 day 参数。
    expect(sqlParams(execute.mock.calls[0][0])).toContain(today);
    // 两次分配 + 两次插入均发生（同事务内）。
    expect(execute).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(insertValues.mock.calls[0][0].snapshotVersion).toBe(`WS-${today}-0001`);
    expect(insertValues.mock.calls[1][0].snapshotVersion).toBe(`WS-${today}-0002`);
  });

  it('跨日回卷：WS-<d1>-0001 → WS-<d2>-0001（day 参数随日期切换，不继承昨日序号）', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-10T12:00:00+08:00'));

    const db = makeDb();
    const { svc, execute } = makeSvc(db);
    execute.mockReset();
    execute.mockResolvedValue([{ last_seq: 1 }]);

    const d1 = localStamp(new Date());
    const s1 = await svc.buildSnapshot(ctx);
    expect(s1.snapshotVersion).toBe(`WS-${d1}-0001`);
    expect(sqlParams(execute.mock.calls[0][0])).toContain(d1);

    jest.setSystemTime(new Date('2026-08-11T12:00:00+08:00'));
    const d2 = localStamp(new Date());
    expect(d2).not.toBe(d1);
    const s2 = await svc.buildSnapshot(ctx);
    expect(s2.snapshotVersion).toBe(`WS-${d2}-0001`);
    expect(sqlParams(execute.mock.calls[1][0])).toContain(d2);
  });

  it('唯一冲突（23505）→ 有界重试：首次插入失败、重试以全新版本成功', async () => {
    const db = makeDb();
    const { svc, runInTransaction, insertValues, execute } = makeSvc(db);
    execute.mockReset();
    execute
      .mockResolvedValueOnce([{ last_seq: 1 }])
      .mockResolvedValueOnce([{ last_seq: 2 }]);
    insertValues
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint "ewoh_world_state_snapshot_snapshot_version_key"'), {
          code: '23505',
        }),
      )
      .mockResolvedValueOnce(undefined);

    const today = localStamp(new Date());
    const snap = await svc.buildSnapshot(ctx);

    expect(snap.snapshotVersion).toBe(`WS-${today}-0002`);
    expect(execute).toHaveBeenCalledTimes(2); // 两次分配（全新版本）
    expect(runInTransaction).toHaveBeenCalledTimes(2); // 两次独立事务
  });

  it('超过 MAX_ATTEMPTS（3）次冲突 → 抛明确错误，绝不无限循环', async () => {
    const db = makeDb();
    const { svc, insertValues, execute, runInTransaction } = makeSvc(db);
    execute.mockReset();
    execute.mockResolvedValue([{ last_seq: 1 }]); // 每次重试都拿到相同冲突版本
    insertValues.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    );

    await expect(svc.buildSnapshot(ctx)).rejects.toThrow(
      /world snapshot version allocation failed after 3 attempts/,
    );
    expect(execute).toHaveBeenCalledTimes(3); // 恰好 3 次尝试后终止
    expect(runInTransaction).toHaveBeenCalledTimes(3);
    expect(insertValues).toHaveBeenCalledTimes(3);
  });
});
