import { RequestDatabaseContext } from '../../../server/database/request-database-context';

describe('RequestDatabaseContext', () => {
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
    // 空/全局设置：系统事务不执行任何 set_config GUC。
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
    // 外层 1 个 GUC；systemTransaction 复用事务且不再追加任何 GUC。
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
