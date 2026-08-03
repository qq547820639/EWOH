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
});
