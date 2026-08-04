import { ConflictException } from '@nestjs/common';
import { DomainPersistenceService } from '@server/modules/work-orchestration/domain-persistence.service';
import {
  ewohEvidenceMetadata,
  ewohFactoryReplicationSessions,
  ewohGitSyncState,
  ewohHandoffs,
  ewohIdempotencyKeys,
  ewohResourceLocks,
} from '@server/database/schema';

interface DbHandle {
  db: {
    select: () => {
      from: () => { where: () => Promise<unknown[]>; orderBy: () => unknown };
    };
    insert: () => {
      values: () => {
        returning: () => Promise<unknown[]>;
        onConflictDoNothing: () => Promise<{ rowCount: number | null }>;
        onConflictDoUpdate: () => Promise<{ rowCount: number | null }>;
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
    execute: () => Promise<unknown[]>;
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
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
    onConflictDoUpdate: () =>
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
  const db = {
    select: select.select,
    insert: insert.insert,
    update: update.update,
    execute: () => Promise.resolve([]),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db };
}

function handoffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    handoffId: 'HO-1',
    fromActor: 'AG-11',
    toActor: 'ORCH-05',
    scope: 'scope-x',
    contextPack: null,
    acceptance: null,
    openQuestions: [],
    state: 'open',
    createdAt: new Date(),
    ...overrides,
  };
}

function replicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    sessionId: 'RS-1',
    orgId: 'org-1',
    factoryId: 'factory-1',
    step: 'mapping',
    status: 'running',
    progress: 0,
    startedAt: new Date(),
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// F61-02: a stateful in-memory mock that implements the drizzle query-builder
// chain, so the DomainPersistenceService call-chain is exercised faithfully
// WITHOUT a PostgreSQL process. It keeps rows across calls (persistence
// semantics), enforces (scope, idempotencyKey) uniqueness, applies optimistic
// version CAS on updates, and rolls back a transaction when the inner step
// throws. This is the "no-environment" storage adapter for the persistence
// scenarios (2.E) that cannot run against a real DB on this machine.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

interface Comparison {
  col: string;
  op: string;
  right: unknown;
}

function tableNameOf(table: unknown): string {
  return (table as Record<symbol, unknown>)?.[Symbol.for('drizzle:Name')] as string;
}

function colProp(table: unknown, dbName: string): string | undefined {
  const t = table as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    const col = t[key] as { name?: string } | undefined;
    if (col && typeof col === 'object' && col.name === dbName) return key;
  }
  return dbName;
}

function isColumnRef(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { name?: unknown }).name === 'string' &&
    (v as { table?: unknown }).table !== undefined
  );
}

function sqlText(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return '';
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c && Array.isArray((c as { value?: unknown[] }).value)) {
        return ((c as { value: string[] }).value ?? []).join('');
      }
      if (isColumnRef(c)) return (c as { name: string }).name;
      return ' ';
    })
    .join('');
}

interface CondToken {
  kind: 'text' | 'col' | 'value';
  text?: string;
  name?: string;
  val?: unknown;
}

/**
 * Flatten the (possibly nested) drizzle SQL chunk tree into a flat token stream:
 *  - column refs -> { kind: 'col', name }
 *  - SQL text params (`{ value: string[] }`) -> { kind: 'text' }
 *  - bound value params (`{ brand, value, encoder }`) -> { kind: 'value' }
 *  - nested `queryChunks` are recursed into
 */
function flattenCondition(cond: unknown, out: CondToken[]): void {
  const sqlObj = (
    typeof cond === 'function'
      ? (cond as (t: unknown) => unknown)(undefined)
      : cond
  ) as { queryChunks?: unknown[] };
  const chunks = sqlObj?.queryChunks ?? [];
  for (const c of chunks) {
    if (typeof c === 'string') {
      out.push({ kind: 'text', text: c });
      continue;
    }
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    if (Array.isArray(obj.queryChunks)) {
      flattenCondition(c as unknown as { queryChunks: unknown[] }, out);
    } else if (isColumnRef(c)) {
      out.push({ kind: 'col', name: (c as { name: string }).name });
    } else if (Array.isArray(obj.value)) {
      const text = (obj.value as unknown[]).map((x) => String(x)).join('');
      out.push({ kind: 'text', text });
    } else if ('value' in obj) {
      out.push({ kind: 'value', val: obj.value });
    }
  }
}

function extractComparisons(cond: unknown): Comparison[] {
  const tokens: CondToken[] = [];
  flattenCondition(cond, tokens);
  const comps: Comparison[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== 'col') continue;
    // Scan ahead for an operator (and optional now()) in the following text tokens.
    let j = i + 1;
    let op: string | null = null;
    let hasNow = false;
    while (j < tokens.length && tokens[j].kind === 'text') {
      const t = tokens[j].text!.trim();
      const m = t.match(/^(<=|>=|=|<|>)/);
      if (m) {
        op = m[1];
        hasNow = /now\(\)/.test(t);
        break;
      }
      j += 1;
    }
    if (!op) continue;
    let right: unknown;
    if (hasNow) {
      right = 'now()';
    } else {
      let k = j + 1;
      while (k < tokens.length && tokens[k].kind === 'text') k += 1;
      if (k >= tokens.length || tokens[k].kind !== 'value') continue;
      right = tokens[k].val;
    }
    comps.push({ col: tokens[i].name!, op, right });
  }
  return comps;
}

function normalizeCompare(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return v;
}

function compare(left: unknown, op: string, right: unknown): boolean {
  const l = normalizeCompare(left);
  const r = right === 'now()' ? Date.now() : normalizeCompare(right);
  switch (op) {
    case '=':
      return l === r;
    case '>':
      return (l as number) > (r as number);
    case '>=':
      return (l as number) >= (r as number);
    case '<':
      return (l as number) < (r as number);
    case '<=':
      return (l as number) <= (r as number);
    default:
      return false;
  }
}

function matches(cond: unknown, table: unknown, row: MockRow): boolean {
  const comps = extractComparisons(cond);
  return comps.every((c) => {
    const prop = colProp(table, c.col);
    const left = row[prop ?? c.col];
    return compare(left, c.op, c.right);
  });
}

function insertRowValue(value: unknown): unknown {
  if (value && typeof value === 'object' && (value as { queryChunks?: unknown[] }).queryChunks) {
    const text = sqlText(value);
    if (/now\(\)/.test(text)) return new Date();
    return value;
  }
  return value;
}

function setRowValue(value: unknown, current: unknown): unknown {
  if (value && typeof value === 'object' && (value as { queryChunks?: unknown[] }).queryChunks) {
    const text = sqlText(value);
    if (/now\(\)/.test(text)) return new Date();
    const plus = text.match(/[a-z_]+\s*\+\s*(\d+)/i);
    if (plus) {
      return Number(current ?? 0) + Number(plus[1]);
    }
    return current;
  }
  return value;
}

class StatefulDb {
  private readonly data = new Map<string, MockRow[]>();
  private readonly failOnExecute: boolean;

  constructor(options: { failOnExecute?: boolean } = {}) {
    this.failOnExecute = options.failOnExecute ?? false;
  }

  /** Test-only accessor to inspect what was actually persisted. */
  rowsOf(table: unknown): MockRow[] {
    const name = tableNameOf(table);
    return this.data.get(name) ?? [];
  }

  private tableRows(table: unknown): MockRow[] {
    const name = tableNameOf(table);
    let rows = this.data.get(name);
    if (!rows) {
      rows = [];
      this.data.set(name, rows);
    }
    return rows;
  }

  private snapshot(): Map<string, MockRow[]> {
    return new Map(
      Array.from(this.data.entries()).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
    );
  }

  private restore(snap: Map<string, MockRow[]>): void {
    this.data.clear();
    snap.forEach((v, k) => this.data.set(k, v));
  }

  select() {
    const tableRef: { table?: unknown } = {};
    const q = {
      from: (table: unknown) => {
        tableRef.table = table;
        return q;
      },
      where: (cond: unknown) => new SelectResult(this, () => tableRef.table, cond),
    };
    return q;
  }

  insert(table: unknown) {
    const pending: { values?: MockRow } = {};
    const self = this;
    return {
      values: (obj: MockRow) => {
        pending.values = obj;
        const chain = {
          onConflictDoNothing: async () => {
            const rows = self.tableRows(table);
            const v = pending.values!;
            const dup = rows.find(
              (r) => r.scope === v.scope && r.idempotencyKey === v.idempotencyKey,
            );
            if (dup) return { rowCount: 0 };
            rows.push(self.normalizeInsert(v));
            return { rowCount: 1 };
          },
          onConflictDoUpdate: async (opts: { target: unknown; set: MockRow }) => {
            const rows = self.tableRows(table);
            const v = pending.values!;
            const targetProp = colProp(table, (opts.target as { name: string }).name);
            const existing = rows.find((r) => r[targetProp ?? ''] === v[targetProp ?? '']);
            if (existing) {
              Object.keys(opts.set).forEach((key) => {
                existing[key] = setRowValue(opts.set[key], existing[key]);
              });
              return { rowCount: 1 };
            }
            rows.push(self.normalizeInsert(v));
            return { rowCount: 1 };
          },
          returning: async () => {
            const rows = self.tableRows(table);
            const row = self.normalizeInsert(pending.values!);
            rows.push(row);
            return [{ ...row }];
          },
          // ::: thenable :::
          // The service's createHandoff / createReplicationSession paths do
          // `await db.insert(...).values({...})` (a plain INSERT with no
          // returning/clause). In real drizzle the values() builder is thenable
          // and executes on await; the mock must mirror that so the row is
          // actually persisted.
          then: (
            onfulfilled?: ((v: { rowCount: number }) => unknown) | null,
            onrejected?: ((e: unknown) => unknown) | null,
          ) => {
            const rows = self.tableRows(table);
            rows.push(self.normalizeInsert(pending.values!));
            return Promise.resolve({ rowCount: 1 }).then(onfulfilled, onrejected);
          },
        };
        return chain;
      },
    };
  }

  update(table: unknown) {
    const pending: { set?: MockRow; cond?: unknown; table?: unknown } = { table };
    return {
      set: (obj: MockRow) => {
        pending.set = obj;
        return {
          where: (cond: unknown) => new UpdateResult(this, pending, cond),
        };
      },
    };
  }

  async transaction(fn: (tx: unknown) => Promise<unknown>): Promise<unknown> {
    const snap = this.snapshot();
    try {
      return await fn(this);
    } catch (err) {
      this.restore(snap);
      throw err;
    }
  }

  async execute(): Promise<MockRow[]> {
    if (this.failOnExecute) {
      throw new Error('simulated audit write failure');
    }
    return [];
  }

  private normalizeInsert(value: MockRow): MockRow {
    const row: MockRow = {};
    Object.keys(value).forEach((key) => {
      row[key] = insertRowValue(value[key]);
    });
    return row;
  }
}

class SelectResult implements PromiseLike<MockRow[]> {
  private readonly order: { table: unknown; col: unknown }[] = [];

  constructor(
    private readonly db: StatefulDb,
    private readonly table: () => unknown,
    private readonly cond: unknown,
  ) {}

  orderBy(col: unknown) {
    this.order.push({ table: this.table(), col });
    return this;
  }

  then<TResult1 = MockRow[], TResult2 = never>(
    onfulfilled?: ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }

  private resolve(): MockRow[] {
    const table = this.table();
    const rows = this.db.rowsOf(table);
    let result = rows;
    if (this.cond !== undefined) {
      result = result.filter((row) => matches(this.cond, table, row));
    }
    for (const o of this.order) {
      const prop = colProp(o.table, (o.col as { name: string }).name);
      result = [...result].sort((a, b) => {
        const left = a[prop ?? ''] as unknown;
        const right = b[prop ?? ''] as unknown;
        return String(left ?? '').localeCompare(String(right ?? ''));
      });
    }
    return result.map((row) => ({ ...row }));
  }
}

class UpdateResult implements PromiseLike<{ rowCount: number }> {
  private applied: MockRow[] | null = null;

  constructor(
    private readonly db: StatefulDb,
    private readonly pending: { set?: MockRow; table?: unknown },
    private readonly cond: unknown,
  ) {}

  async returning(projection?: Record<string, unknown>): Promise<MockRow[]> {
    const rows = this.apply();
    if (!projection) return rows.map((row) => ({ ...row }));
    const props = Object.values(projection).map((col) =>
      colProp(this.pending.table!, (col as { name: string }).name),
    );
    return rows.map((row) =>
      Object.fromEntries(props.map((p) => [p, row[p]])) as MockRow,
    );
  }

  then<TResult1 = { rowCount: number }, TResult2 = never>(
    onfulfilled?: ((value: { rowCount: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ rowCount: this.apply().length }).then(
      onfulfilled,
      onrejected,
    );
  }

  private apply(): MockRow[] {
    if (this.applied) return this.applied;
    const table = this.pending.table!;
    const rows = this.db.rowsOf(table);
    const targets = rows.filter((row) => matches(this.cond, table, row));
    const set = this.pending.set!;
    targets.forEach((row) => {
      Object.keys(set).forEach((key) => {
        row[key] = setRowValue(set[key], row[key]);
      });
    });
    this.applied = targets;
    return targets;
  }
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

  // --- 2.C composite transaction methods ---

  it('acquires a lock and registers its audit event atomically', async () => {
    const { db } = buildDb({
      selectRows: [],
      insertReturning: [lockRow({ holder: 'user-1', version: 1 })],
    });
    const service = new DomainPersistenceService(db as never);
    const record = await service.acquireLockWithAudit(
      {
        orgId: 'org-1',
        resourceKey: 'res-1',
        resourceId: 'res-1',
        holder: 'user-1',
      },
      {
        actorId: 'user-1',
        action: 'lock.acquire',
        entityType: 'resource_lock',
        entityId: 'res-1',
      },
    );
    expect(record.holder).toBe('user-1');
    expect(record.active).toBe(true);
  });

  it('acquireLockWithAudit refuses an active lock held by another holder', async () => {
    const { db } = buildDb({
      selectRows: [lockRow({ holder: 'user-2', active: true })],
    });
    const service = new DomainPersistenceService(db as never);
    await expect(
      service.acquireLockWithAudit(
        {
          orgId: 'org-1',
          resourceKey: 'res-1',
          resourceId: 'res-1',
          holder: 'user-1',
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a handoff and its responsibility-transfer evidence atomically', async () => {
    const { db } = buildDb({ selectRows: [] });
    const service = new DomainPersistenceService(db as never);
    const handoff = await service.createHandoffWithTransfer(
      {
        handoffId: 'HO-1',
        fromActor: 'AG-11',
        toActor: 'ORCH-05',
        scope: 'scope-x',
      },
      {
        evidenceId: 'EVD-HO-1',
        workItemId: 'scope-x',
        verifier: 'user-1',
        result: 'handoff_created',
      },
    );
    expect(handoff.handoffId).toBe('HO-1');
    expect(handoff.state).toBe('open');
  });

  it('accepts a handoff and registers the transfer evidence atomically', async () => {
    const { db } = buildDb({
      selectRows: [],
      updateReturning: [handoffRow({ state: 'accepted' })],
    });
    const service = new DomainPersistenceService(db as never);
    const handoff = await service.acceptHandoffWithTaskUpdate('HO-1', {
      evidenceId: 'EVD-HO-1',
      workItemId: 'scope-x',
      verifier: 'user-2',
      result: 'handoff_accepted',
    });
    expect(handoff?.state).toBe('accepted');
  });

  it('advances git-sync state and its evidence atomically', async () => {
    const { db } = buildDb({ selectRows: [] });
    const service = new DomainPersistenceService(db as never);
    await expect(
      service.updateGitSyncWithEvidence(
        {
          syncId: 'git-sync',
          lastSyncSha: 'abc123',
          lastSyncStatus: 'live',
        },
        {
          evidenceId: 'EVD-git-sync',
          workItemId: 'git-sync',
          commitSha: 'abc123',
          result: 'git_sync_applied',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('advances a replication step and generates its output evidence atomically', async () => {
    const { db } = buildDb({
      selectRows: [],
      updateReturning: [replicationRow({ step: 'install', progress: 50 })],
    });
    const service = new DomainPersistenceService(db as never);
    const session = await service.advanceReplicationWithEvidence(
      'RS-1',
      { step: 'install', progress: 50 },
      {
        evidenceId: 'EVD-RS-1',
        workItemId: 'RS-1',
        verifier: 'user-1',
        result: 'step_advanced',
      },
    );
    expect(session?.step).toBe('install');
    expect(session?.progress).toBe(50);
  });

  it('replays an existing idempotency key without creating a second business object', async () => {
    const { db } = buildDb({
      selectRows: [
        { id: 'k1', scope: 'git-sync-apply', idempotencyKey: 'k-1', response: { ok: true } },
      ],
    });
    const service = new DomainPersistenceService(db as never);
    const { created, result } = await service.setIdempotencyAndCreate(
      'git-sync-apply',
      'k-1',
      async () => ({ ok: false }),
    );
    expect(created).toBe(false);
    expect(result).toEqual({ ok: true });
  });

  it('creates one business object for a new idempotency key inside a transaction', async () => {
    const { db } = buildDb({ selectRows: [] });
    const service = new DomainPersistenceService(db as never);
    let calls = 0;
    const { created, result } = await service.setIdempotencyAndCreate(
      'git-sync-apply',
      'k-new',
      async () => {
        calls += 1;
        return { n: 1 };
      },
    );
    expect(calls).toBe(1);
    expect(created).toBe(true);
    expect(result).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------
// F61-02 2.E "no-environment" storage-adapter scenarios (Task 2.16).
//
// These exercise the full DomainPersistenceService call-chain against the
// STATEFUL StatefulDb mock (implements the drizzle query-builder chain, keeps
// rows across calls, enforces uniqueness, applies optimistic version CAS, and
// rolls back transactions), so the persistence / multi-instance / transaction
// semantics are verified WITHOUT a PostgreSQL process.
//
// Scenario map:
//   1  state survives a service restart over the same DB
//   2  two instances cannot both acquire the same lock (unique (org,key))
//   5  an expired lock can be safely taken over by a new holder
//   6  a non-holder cannot renew or release a lock
//   7  optimistic-lock CAS: a superseded version/holder is rejected
//   8  (scope, idempotencyKey) unique constraint coalesces duplicate writes
//   9  a mid-transaction failure leaves NO partial write (rollback)
//   10 a replayed idempotency key creates exactly one business object
//   +  handoff / git-sync / evidence / replication-session persistence recovery
// ---------------------------------------------------------------------------
describe('DomainPersistenceService (StatefulDb — no-PostgreSQL persistence)', () => {
  function makeService(db: StatefulDb): DomainPersistenceService {
    return new DomainPersistenceService(db as never);
  }

  // Scenario 1: state survives a service restart over the same DB.
  it('persists replication / handoff / evidence state across a service restart', async () => {
    const db = new StatefulDb();
    const svc1 = makeService(db);
    await svc1.createReplicationSession({
      sessionId: 'RS-restart',
      orgId: 'org-1',
      factoryId: 'factory-1',
      step: 'mapping',
    });
    await svc1.createHandoff({
      handoffId: 'HO-restart',
      fromActor: 'AG-11',
      toActor: 'ORCH-05',
      scope: 'scope-restart',
    });
    await svc1.upsertEvidenceMetadata({
      evidenceId: 'EVD-restart',
      workItemId: 'scope-restart',
      result: 'pass',
    });

    // "Restart": a brand-new service instance over the SAME database.
    const svc2 = makeService(db);
    expect(db.rowsOf(ewohFactoryReplicationSessions)).toHaveLength(1);
    expect(db.rowsOf(ewohHandoffs)).toHaveLength(1);
    expect(db.rowsOf(ewohEvidenceMetadata)).toHaveLength(1);

    // The new instance can read back the persisted state.
    const handoff = await svc2.getHandoff('HO-restart');
    expect(handoff?.state).toBe('open');
    const evidence = await svc2.getEvidenceMetadata('EVD-restart');
    expect(evidence?.result).toBe('pass');
  });

  // Scenario 2: two instances cannot both acquire the same lock.
  it('coalesces two concurrent instances onto a single resource lock', async () => {
    const db = new StatefulDb();
    const svcA = makeService(db);
    const svcB = makeService(db);
    const input = {
      orgId: 'org-1',
      resourceKey: 'res-dual',
      resourceId: 'res-dual',
    };
    const first = await svcA.acquireLock({ ...input, holder: 'instance-a' });
    expect(first.holder).toBe('instance-a');
    await expect(
      svcB.acquireLock({ ...input, holder: 'instance-b' }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Exactly one lock row exists (the unique (orgId, resourceKey) coalescing).
    expect(db.rowsOf(ewohResourceLocks)).toHaveLength(1);
  });

  // Scenario 5: an expired lock can be safely taken over by a new holder.
  it('reassigns an expired lock to a new holder (holder recovery)', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    await svc.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-expired',
      resourceId: 'res-expired',
      holder: 'old-holder',
    });
    // Force the lease to have expired (holder crashed / never renewed).
    const row = db.rowsOf(ewohResourceLocks)[0];
    row.expiresAt = new Date(Date.now() - 1000);
    row.active = true;

    const recovered = await svc.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-expired',
      resourceId: 'res-expired',
      holder: 'new-holder',
    });
    expect(recovered.holder).toBe('new-holder');
    expect(recovered.active).toBe(true);
    expect(db.rowsOf(ewohResourceLocks)).toHaveLength(1);
  });

  // Scenario 6: a non-holder cannot renew or release a lock.
  it('rejects renew and release by a non-holder without admin', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    await svc.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-owned',
      resourceId: 'res-owned',
      holder: 'owner',
    });

    const renew = await svc.renewLock({
      orgId: 'org-1',
      resourceKey: 'res-owned',
      holder: 'intruder',
    });
    expect(renew).toBeNull();

    await expect(
      svc.releaseLock({
        orgId: 'org-1',
        resourceKey: 'res-owned',
        holder: 'intruder',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Scenario 7: optimistic-lock CAS — a superseded version/holder is rejected.
  it('rejects a renewal whose holder/version was superseded by a concurrent write', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    await svc.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-cas',
      resourceId: 'res-cas',
      holder: 'holder-a',
    });
    // Simulate "another instance" winning the CAS: it bumped the version and
    // took over the lock. The stale holder's later operation must be rejected
    // rather than silently clobbering the newer state.
    const row = db.rowsOf(ewohResourceLocks)[0];
    row.version = (row.version as number) + 1;
    row.holder = 'holder-b';

    const staleRenew = await svc.renewLock({
      orgId: 'org-1',
      resourceKey: 'res-cas',
      holder: 'holder-a',
    });
    expect(staleRenew).toBeNull();
    expect(db.rowsOf(ewohResourceLocks)[0].holder).toBe('holder-b');
  });

  it('increments the lock version on each guarded renewal (CAS visible)', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    await svc.acquireLock({
      orgId: 'org-1',
      resourceKey: 'res-cas2',
      resourceId: 'res-cas2',
      holder: 'u1',
    });
    const before = db.rowsOf(ewohResourceLocks)[0].version as number;
    const renewed = await svc.renewLock({
      orgId: 'org-1',
      resourceKey: 'res-cas2',
      holder: 'u1',
    });
    expect(renewed?.version).toBe(before + 1);
    expect(db.rowsOf(ewohResourceLocks)[0].version).toBe(before + 1);
  });

  // Scenario 8: (scope, idempotencyKey) unique constraint coalesces writes.
  it('deduplicates on the (scope, key) unique constraint', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    let calls = 0;
    const input = async () => {
      calls += 1;
      return { n: calls };
    };
    const first = await svc.setIdempotencyAndCreate('git-sync-apply', 'k-unique', input);
    const second = await svc.setIdempotencyAndCreate('git-sync-apply', 'k-unique', input);
    expect(calls).toBe(1);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.result).toEqual({ n: 1 });
    expect(db.rowsOf(ewohIdempotencyKeys)).toHaveLength(1);
  });

  // Scenario 9: a mid-transaction failure leaves NO partial write.
  it('rolls back the whole transaction when the audit write fails (no partial lock)', async () => {
    const db = new StatefulDb({ failOnExecute: true });
    const svc = makeService(db);
    await expect(
      svc.acquireLockWithAudit(
        {
          orgId: 'org-1',
          resourceKey: 'res-tx',
          resourceId: 'res-tx',
          holder: 'u1',
        },
        {
          actorId: 'u1',
          action: 'lock.acquire',
          entityType: 'resource_lock',
          entityId: 'res-tx',
        },
      ),
    ).rejects.toThrow('simulated audit write failure');
    // The lock acquisition must be rolled back with the failed audit write.
    expect(db.rowsOf(ewohResourceLocks)).toHaveLength(0);
  });

  // Scenario 10: a replayed idempotency key creates exactly one business object.
  it('replays an offline operation without creating a duplicate object', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    const creator = async () => ({ orderId: 'SO-1' });
    const first = await svc.setIdempotencyAndCreate('erp-order', 'offline-op-1', creator);
    const replay = await svc.setIdempotencyAndCreate('erp-order', 'offline-op-1', creator);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.result).toEqual({ orderId: 'SO-1' });
    expect(db.rowsOf(ewohIdempotencyKeys)).toHaveLength(1);
  });

  // Handoff / git-sync / evidence / replication-session persistence recovery.
  it('persists handoff, git-sync, evidence, and replication state', async () => {
    const db = new StatefulDb();
    const svc = makeService(db);
    await svc.createHandoff({
      handoffId: 'HO-persist',
      fromActor: 'AG-11',
      toActor: 'ORCH-05',
      scope: 'scope-persist',
    });
    await svc.updateGitSyncWithEvidence(
      { syncId: 'G-persist', lastSyncSha: 'abc123', lastSyncStatus: 'live' },
      { evidenceId: 'EVD-git-persist', workItemId: 'scope-persist', result: 'ok' },
    );
    await svc.createReplicationSession({
      sessionId: 'RS-persist',
      orgId: 'org-1',
      factoryId: 'factory-1',
    });
    expect(db.rowsOf(ewohHandoffs)).toHaveLength(1);
    expect(db.rowsOf(ewohGitSyncState)).toHaveLength(1);
    expect(db.rowsOf(ewohEvidenceMetadata)).toHaveLength(1);
    expect(db.rowsOf(ewohFactoryReplicationSessions)).toHaveLength(1);
  });

  it('advances a handoff and replication state after a service restart', async () => {
    const db = new StatefulDb();
    const svc1 = makeService(db);
    await svc1.createHandoff({
      handoffId: 'HO-advance',
      fromActor: 'AG-11',
      toActor: 'ORCH-05',
      scope: 'scope-advance',
    });
    await svc1.createReplicationSession({
      sessionId: 'RS-advance',
      orgId: 'org-1',
      factoryId: 'factory-1',
    });

    const svc2 = makeService(db);
    const accepted = await svc2.acceptHandoffWithTaskUpdate('HO-advance', {
      evidenceId: 'EVD-advance',
      workItemId: 'scope-advance',
      verifier: 'user-2',
      result: 'handoff_accepted',
    });
    expect(accepted?.state).toBe('accepted');
    const advanced = await svc2.updateReplicationSession('RS-advance', {
      step: 'install',
      progress: 50,
    });
    expect(advanced?.step).toBe('install');
    expect(advanced?.progress).toBe(50);
  });
});