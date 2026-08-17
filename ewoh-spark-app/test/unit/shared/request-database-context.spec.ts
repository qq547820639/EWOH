import { RequestDatabaseContext } from '../../../server/database/request-database-context';
import { withRequestContext } from '../../../server/common/request-context';

describe('RequestDatabaseContext', () => {
  const originalTimeout = process.env.EWOH_DB_STATEMENT_TIMEOUT_MS;
  const originalRequireTx = process.env.EWOH_DB_REQUIRE_TX;

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.EWOH_DB_STATEMENT_TIMEOUT_MS;
    else process.env.EWOH_DB_STATEMENT_TIMEOUT_MS = originalTimeout;
    if (originalRequireTx === undefined) delete process.env.EWOH_DB_REQUIRE_TX;
    else process.env.EWOH_DB_REQUIRE_TX = originalRequireTx;
  });

  // NEST-516：runInTransaction 默认追加 statement_timeout GUC（缺省 30s）。
  // GUC 路由类用例显式关闭（0）以聚焦租户 GUC 语义；注入行为单独用例覆盖。
  beforeEach(() => {
    process.env.EWOH_DB_STATEMENT_TIMEOUT_MS = '0';
    delete process.env.EWOH_DB_REQUIRE_TX;
  });

  it('routes queries through the transaction only while the request context is active', async () => {
    const transaction = {
      marker: 'transaction',
      execute: jest.fn().mockResolvedValue([]),
      currentMarker(this: { marker: string }) {
        return this.marker;
      },
    };
    const rootDatabase = {
      marker: 'root',
      currentMarker(this: { marker: string }) {
        return this.marker;
      },
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);
    const proxiedDatabase = context.database as unknown as {
      currentMarker: () => string;
    };

    expect(proxiedDatabase.currentMarker()).toBe('root');

    const marker = await context.runInTransaction(
      [
        { name: 'app.user_id', value: 'user-1' },
        { name: 'app.current_org_id', value: 'org-a' },
      ],
      async () => proxiedDatabase.currentMarker(),
    );

    expect(marker).toBe('transaction');
    expect(rootDatabase.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(2);
    expect(proxiedDatabase.currentMarker()).toBe('root');
  });

  it('NEST-516: runInTransaction 默认追加 statement_timeout GUC（缺省 30s）', async () => {
    delete process.env.EWOH_DB_STATEMENT_TIMEOUT_MS;
    const transaction = {
      execute: jest.fn().mockResolvedValue([]),
    };
    const rootDatabase = {
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);

    await context.runInTransaction(
      [{ name: 'app.current_org_id', value: 'org-a' }],
      async () => 'ok',
    );

    // 1 个租户 GUC + 1 个缺省 statement_timeout（NEST-516）。
    expect(transaction.execute).toHaveBeenCalledTimes(2);
    // 递归收集 SQL 参数对象里的字符串（不依赖 drizzle 内部结构）。
    const strings = new Set<string>();
    const collect = (node: unknown): void => {
      if (typeof node === 'string') strings.add(node);
      else if (node != null && typeof node === 'object') {
        for (const value of Object.values(node as Record<string, unknown>)) collect(value);
      }
    };
    for (const call of transaction.execute.mock.calls) collect(call[0]);
    expect([...strings]).toContain('statement_timeout');
    expect([...strings]).toContain('30000');
  });

  it('NEST-504: HTTP 请求上下文内直接回落根句柄 → EWOH_DB_REQUIRE_TX=1 fail-closed 抛错', async () => {
    process.env.EWOH_DB_REQUIRE_TX = '1';
    const rootDatabase = {
      marker: 'root',
      transaction: jest.fn(),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);

    await withRequestContext({ requestId: 'req-test' }, async () => {
      const proxiedDatabase = context.database as unknown as {
        marker: () => string;
      };
      await expect(Promise.resolve().then(() => proxiedDatabase.marker())).rejects.toThrow(
        /EWOH_DB_REQUIRE_TX/,
      );
    });
  });

  it('reuses the active request transaction instead of opening a nested root transaction', async () => {
    const transaction = {
      marker: 'transaction',
      execute: jest.fn().mockResolvedValue([]),
      currentMarker(this: { marker: string }) {
        return this.marker;
      },
    };
    const rootDatabase = {
      marker: 'root',
      currentMarker(this: { marker: string }) {
        return this.marker;
      },
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);
    const proxiedDatabase = context.database as unknown as {
      currentMarker: () => string;
    };

    let nestedMarker = '';
    await context.runInTransaction(
      [{ name: 'app.current_org_id', value: 'org-a' }],
      async () => {
        nestedMarker = await context.runInTransaction(
          [{ name: 'app.current_org_id', value: 'org-b' }],
          async () => proxiedDatabase.currentMarker(),
        );
      },
    );

    expect(nestedMarker).toBe('transaction');
    expect(rootDatabase.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(2);
    expect(proxiedDatabase.currentMarker()).toBe('root');
  });

  it('propagates inner failures without opening a second root transaction', async () => {
    const transaction = {
      execute: jest.fn().mockResolvedValue([]),
    };
    const rootDatabase = {
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);

    await expect(
      context.runInTransaction(
        [{ name: 'app.current_org_id', value: 'org-a' }],
        async () => {
          await context.runInTransaction(
            [{ name: 'app.current_org_id', value: 'org-b' }],
            async () => {
              throw new Error('inner boom');
            },
          );
        },
      ),
    ).rejects.toThrow('inner boom');

    expect(rootDatabase.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(2);
  });

  it('systemTransaction runs on the root handle without tenant GUC settings', async () => {
    const transaction = {
      marker: 'transaction',
      execute: jest.fn().mockResolvedValue([]),
    };
    const rootDatabase = {
      marker: 'root',
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);

    const marker = await context.systemTransaction(async (db) => {
      return (db as unknown as { marker: string }).marker;
    });

    expect(marker).toBe('transaction');
    expect(rootDatabase.transaction).toHaveBeenCalledTimes(1);
    // 空/全局设置：系统事务不执行任何租户 GUC set_config。
    expect(transaction.execute).not.toHaveBeenCalled();
  });

  it('systemTransaction reuses an active request transaction without adding GUC settings', async () => {
    const transaction = {
      marker: 'transaction',
      execute: jest.fn().mockResolvedValue([]),
    };
    const rootDatabase = {
      marker: 'root',
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);

    let systemMarker = '';
    await context.runInTransaction(
      [{ name: 'app.current_org_id', value: 'org-a' }],
      async () => {
        systemMarker = await context.systemTransaction(async (db) => {
          return (db as unknown as { marker: string }).marker;
        });
      },
    );

    expect(systemMarker).toBe('transaction');
    expect(rootDatabase.transaction).toHaveBeenCalledTimes(1);
    // 外层 1 个 GUC；systemTransaction 复用事务且不再追加任何租户 GUC。
    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });

  it('systemTransaction propagates inner failures and rolls back', async () => {
    const transaction = {
      execute: jest.fn().mockResolvedValue([]),
    };
    const rootDatabase = {
      transaction: jest.fn(
        async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
      ),
    };
    const context = new RequestDatabaseContext(rootDatabase as never);

    await expect(
      context.systemTransaction(async () => {
        throw new Error('system boom');
      }),
    ).rejects.toThrow('system boom');

    expect(rootDatabase.transaction).toHaveBeenCalledTimes(1);
  });
});
