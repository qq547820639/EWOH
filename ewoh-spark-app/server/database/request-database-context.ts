import { Inject, Injectable, Optional } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { currentRequestContext } from '../common/request-context';
import { SlowQueryService } from '../modules/observability/slow-query.service';

export const STANDALONE_ROOT_DATABASE = Symbol('STANDALONE_ROOT_DATABASE');

export interface TransactionSetting {
  name: string;
  value: string;
}

type StandaloneDatabase = PostgresJsDatabase<Record<string, never>>;

@Injectable()
export class RequestDatabaseContext {
  private readonly storage = new AsyncLocalStorage<StandaloneDatabase>();

  readonly database: StandaloneDatabase;

  constructor(
    @Inject(STANDALONE_ROOT_DATABASE) private readonly rootDatabase: StandaloneDatabase,
    @Optional() private readonly slowQueryService?: SlowQueryService,
  ) {
    this.database = new Proxy({} as StandaloneDatabase, {
      get: (_target, property) => {
        const database = this.storage.getStore() ?? this.rootDatabase;
        const value = Reflect.get(database, property, database) as unknown;
        return typeof value === 'function' ? value.bind(database) : value;
      },
    });
  }

  async runInTransaction<T>(
    settings: readonly TransactionSetting[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const thresholdMs = Number(process.env.EWOH_DB_SLOW_THRESHOLD_MS || 1000);
    const statementTimeoutMs = Number(process.env.EWOH_DB_STATEMENT_TIMEOUT_MS || 0);
    const effectiveSettings =
      statementTimeoutMs > 0
        ? [
            ...settings,
            { name: 'statement_timeout', value: String(statementTimeoutMs) },
          ]
        : settings;
    try {
      const activeTransaction = this.storage.getStore();
      if (activeTransaction) {
        // Keep one request on one transaction/connection. There is no savepoint:
        // an inner failure aborts the whole request transaction, and inner GUC
        // settings persist for the remainder of the active transaction. Callers
        // must rethrow rather than continue after an inner failure.
        for (const setting of effectiveSettings) {
          await activeTransaction.execute(
            sql`select set_config(${setting.name}, ${setting.value}, true)`,
          );
        }
        return operation();
      }

      return this.rootDatabase.transaction(async (transaction) => {
        for (const setting of effectiveSettings) {
          await transaction.execute(
            sql`select set_config(${setting.name}, ${setting.value}, true)`,
          );
        }

        return this.storage.run(transaction as unknown as StandaloneDatabase, operation);
      });
    } finally {
      const durationMs = Date.now() - startedAt;
      if (thresholdMs > 0 && durationMs >= thresholdMs) {
        this.slowQueryService?.record({
          requestId: currentRequestContext()?.requestId,
          label: 'db-transaction',
          durationMs,
          thresholdMs,
          occurredAt: new Date().toISOString(),
        });
      }
    }
  }
}
