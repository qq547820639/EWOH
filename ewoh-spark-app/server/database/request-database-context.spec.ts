/**
 * RUN-01 观测点自测（链行为基线 §5.3h）：
 * 「请求事务结束后仍有续作 join 到同一 store」必须**留下痕迹**，
 * 而合法的嵌套 join（同一事务尚未结束）必须**不报警**——否则这道观测只会制造噪音。
 */
/// <reference types="jest" />
import { RequestDatabaseContext } from './request-database-context';

interface FakeTx {
  execute: () => Promise<undefined>;
}

function makeRootDatabase() {
  const opened: FakeTx[] = [];
  return {
    opened,
    transaction: async (cb: (tx: FakeTx) => Promise<unknown>) => {
      const tx: FakeTx = { execute: async () => undefined };
      opened.push(tx);
      return cb(tx);
    },
  };
}

/** 取出私有 ALS：模拟「续作仍带着请求 store」这一真实条件。 */
function storageOf(ctx: RequestDatabaseContext) {
  return (ctx as unknown as {
    storage: { run: (value: unknown, fn: () => Promise<unknown>) => Promise<unknown> };
  }).storage;
}

function readStore(ctx: RequestDatabaseContext) {
  return (ctx as unknown as { storage: { getStore: () => unknown } }).storage.getStore();
}

describe('RequestDatabaseContext RUN-01 观测', () => {
  const GUC = [{ name: 'app.current_org_id', value: 'org1' }];

  it('事务结束后再 join：console.error 里必须出现 RUN-01，且不改写调用结果', async () => {
    const ctx = new RequestDatabaseContext(makeRootDatabase() as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let store: unknown;
      await ctx.runInTransaction(GUC, async () => {
        store = readStore(ctx);
        return 'committed';
      });
      expect(store).toBeDefined();

      const joined = await storageOf(ctx).run(store, () =>
        ctx.runInTransaction(GUC, async () => 'late-continuation'),
      );

      expect(joined).toBe('late-continuation');
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('RUN-01');
    } finally {
      error.mockRestore();
    }
  });

  it('同一事务内部的嵌套 join 不报警（合法复用，不是续作）', async () => {
    const ctx = new RequestDatabaseContext(makeRootDatabase() as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await ctx.runInTransaction(GUC, async () => {
        await ctx.runInTransaction(GUC, async () => undefined);
        await ctx.runInTransaction(GUC, async () => undefined);
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('detached 事务同样纳入观测：它结束后被 join 也要留痕', async () => {
    const ctx = new RequestDatabaseContext(makeRootDatabase() as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let store: unknown;
      await ctx.runDetachedTransaction(GUC, async () => {
        store = readStore(ctx);
        return undefined;
      });
      await storageOf(ctx).run(store, () => ctx.runInTransaction(GUC, async () => undefined));
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('RUN-01');
    } finally {
      error.mockRestore();
    }
  });

  it('EWOH_DB_RUN01_THROW=1 时升级为抛错（运维显式选择严格模式）', async () => {
    const previous = process.env.EWOH_DB_RUN01_THROW;
    process.env.EWOH_DB_RUN01_THROW = '1';
    const ctx = new RequestDatabaseContext(makeRootDatabase() as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let store: unknown;
      await ctx.runInTransaction(GUC, async () => {
        store = readStore(ctx);
        return undefined;
      });
      await expect(
        storageOf(ctx).run(store, () => ctx.runInTransaction(GUC, async () => undefined)),
      ).rejects.toThrow('RUN-01');
    } finally {
      error.mockRestore();
      if (previous === undefined) delete process.env.EWOH_DB_RUN01_THROW;
      else process.env.EWOH_DB_RUN01_THROW = previous;
    }
  });
});
