import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

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
    return this.rootDatabase.transaction(async (transaction) => {
      for (const setting of settings) {
        await transaction.execute(
          sql`select set_config(${setting.name}, ${setting.value}, true)`,
        );
      }

      return this.storage.run(transaction as unknown as StandaloneDatabase, operation);
    });
  }
}
