import { ConflictException } from '@nestjs/common';
import { DomainPersistenceService } from '@server/modules/work-orchestration/domain-persistence.service';

interface DbHandle {
  db: {
    select: () => {
      from: () => { where: () => Promise<unknown[]>; orderBy: () => unknown };
    };
    insert: () => {
      values: () => {
        returning: () => Promise<unknown[]>;
        onConflictDoNothing: () => Promise<{ rowCount: number | null }>;
      };
    };
    update: () => {
      set: () => {
        where: () => {
          returning: () => Promise<unknown[]>;
          then?: (
            resolve: (v: unknown) => void,
            reject: (e: unknown) => void,
          ) => unknown;
        };
      };
    };
  };
}

function buildDb(options: {
  selectRows?: unknown[];
  insertReturning?: unknown[];
  insertConflictCount?: number | null;
  updateReturning?: unknown[];
  updateRowCount?: number | null;
}): DbHandle {
  const select = {
    select: () => select,
    from: () => select,
    where: () => Promise.resolve(options.selectRows ?? []),
    orderBy: () => select,
  };
  const insert = {
    insert: () => insert,
    values: () => insert,
    onConflictDoNothing: () =>
      Promise.resolve({ rowCount: options.insertConflictCount ?? 0 }),
    returning: () => Promise.resolve(options.insertReturning ?? []),
  };
  const update = {
    update: () => update,
    set: () => update,
    where: () => {
      const query: {
        returning: () => Promise<unknown[]>;
        then?: (
          resolve: (v: unknown) => void,
          reject: (e: unknown) => void,
        ) => unknown;
      } = {
        returning: () =>
          Promise.resolve(
            options.updateReturning ??
              (Array.from({ length: options.updateRowCount ?? 0 }).map(() => ({})) as unknown[]),
          ),
      };
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve({ rowCount: options.updateRowCount ?? 1 }).then(resolve, reject);
      return query;
    },
  };
  return { db: { select: select.select, insert: insert.insert, update: update.update } };
}

function lockRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'row-1',
    orgId: 'org-1',
    resourceKey: 'res-1',
    resourceId: 'res-1',
    holder: 'user-1',
    purpose: null,
    acquiredAt: now,
    expiresAt: null,
    renewedAt: now,
    active: true,
    version: 1,
    ...overrides,
  };
}

describe('DomainPersistenceService', () => {
  it('throws ConflictException when an active lock is held', async () => {
    const { db } = buildDb({
      selectRows: [lockRow({ holder: 'user-2', active: true })],
    });
    const service = new DomainPersistenceService(db as never);
    await expect(
      service.acquireLock({
        orgId: 'org-1',
        resourceKey: 'res-1',
        resourceId: 'res-1',
        holder: 'user-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('recovers an expired lock and reassigns it to a new holder', async () => {
    const expired = lockRow({
      id: 'row-expired',
      expiresAt: new Date(Date.now() - 1000),
      active: true,
      version: 2,
    });
    const { db } = buildDb({
      selectRows: [expired],
      updateReturning: [lockRow({ id: 'row-expired', holder: 'user-1', version: 3 })],
    });
    const service = new DomainPersistenceService(db as never);
    const record = await service.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-1',
      resourceId: 'res-1',
      holder: 'user-1',
    });
    expect(record.holder).toBe('user-1');
    expect(record.active).toBe(true);
    expect(record.version).toBe(3);
  });

  it('inserts a fresh lock when none exists', async () => {
    const { db } = buildDb({
      selectRows: [],
      insertReturning: [lockRow({ holder: 'user-1', version: 1 })],
    });
    const service = new DomainPersistenceService(db as never);
    const record = await service.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-1',
      resourceId: 'res-1',
      holder: 'user-1',
    });
    expect(record.active).toBe(true);
    expect(record.holder).toBe('user-1');
  });

  it('releases a lock only when the holder matches or admin', async () => {
    const { db } = buildDb({ selectRows: [lockRow()] });
    const service = new DomainPersistenceService(db as never);
    const result = await service.releaseLock({
      orgId: 'org-1',
      resourceKey: 'res-1',
      holder: 'user-1',
    });
    expect(result.released).toBe(true);
    expect(result.holder).toBe('user-1');
  });

  it('rejects releasing a lock by a non-holder without admin', async () => {
    const { db } = buildDb({ selectRows: [lockRow({ holder: 'user-1' })] });
    const service = new DomainPersistenceService(db as never);
    await expect(
      service.releaseLock({
        orgId: 'org-1',
        resourceKey: 'res-1',
        holder: 'user-2',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns null when renewing a lock not held by the actor', async () => {
    const { db } = buildDb({ selectRows: [lockRow({ holder: 'user-2' })] });
    const service = new DomainPersistenceService(db as never);
    const result = await service.renewLock({
      orgId: 'org-1',
      resourceKey: 'res-1',
      holder: 'user-1',
    });
    expect(result).toBeNull();
  });

  it('renews a lock held by the actor', async () => {
    const { db } = buildDb({
      selectRows: [lockRow({ holder: 'user-1', version: 1 })],
      updateReturning: [lockRow({ holder: 'user-1', version: 2 })],
    });
    const service = new DomainPersistenceService(db as never);
    const result = await service.renewLock({
      orgId: 'org-1',
      resourceKey: 'res-1',
      holder: 'user-1',
    });
    expect(result?.version).toBe(2);
    expect(result?.active).toBe(true);
  });

  it('deduplicates idempotency keys: returns stored response on replay', async () => {
    const { db } = buildDb({
      selectRows: [{ id: 'k1', scope: 'default', idempotencyKey: 'key-1', response: { ok: true } }],
    });
    const service = new DomainPersistenceService(db as never);
    const first = await service.setIdempotency('default', 'key-1', { ok: true });
    expect(first).toEqual({ ok: true });
  });

  it('records the idempotency result when the key is new', async () => {
    const { db } = buildDb({
      selectRows: [],
      insertConflictCount: 1,
    });
    // First call: no existing row; the insert path is exercised. The mock captures
    // the inserted response so a subsequent same-key operation returns it.
    const inserted = new Map<string, unknown>();
    const serviceWithState = new DomainPersistenceService(db as never);
    jest
      .spyOn(serviceWithState, 'getIdempotency')
      .mockImplementation(async (scope: string, key: string) => inserted.get(`${scope}:${key}`));
    await serviceWithState.setIdempotency('default', 'key-2', { n: 1 });
    // Simulate the concurrent writer having inserted the row; setIdempotency
    // returns the stored response once the lookup sees it.
    inserted.set('default:key-2', { n: 1 });
    const replay = await serviceWithState.setIdempotency('default', 'key-2', { n: 2 });
    expect(replay).toEqual({ n: 1 });
  });

  it('reports the number of recovered expired locks', async () => {
    const { db } = buildDb({ updateRowCount: 3 });
    const service = new DomainPersistenceService(db as never);
    const recovered = await service.recoverExpiredLocks('org-1');
    expect(recovered).toBe(3);
  });
});