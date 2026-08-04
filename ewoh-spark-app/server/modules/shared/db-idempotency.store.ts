import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { ewohIdempotencyKeys } from '@server/database/schema';
import type { IdempotencyRecord, IdempotencyStore } from './idempotency.service';

const DEFAULT_SCOPE = 'default';

/**
 * DB-backed idempotency store. Durable across restarts and instances, using the
 * unique (scope, idempotency_key) constraint to deduplicate replay / retries.
 */
@Injectable()
export class DbIdempotencyStore implements IdempotencyStore {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async get<T>(key: string): Promise<IdempotencyRecord<T> | undefined> {
    const [row] = await this.db
      .select()
      .from(ewohIdempotencyKeys)
      .where(
        and(
          eq(ewohIdempotencyKeys.scope, DEFAULT_SCOPE),
          eq(ewohIdempotencyKeys.idempotencyKey, key),
        ),
      );
    if (!row) return undefined;
    const createdAt =
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    return { key, response: row.response as T, createdAt };
  }

  async set<T>(key: string, response: T): Promise<IdempotencyRecord<T>> {
    const now = new Date();
    await this.db
      .insert(ewohIdempotencyKeys)
      .values({
        scope: DEFAULT_SCOPE,
        idempotencyKey: key,
        response: response as unknown,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const existing = await this.get<T>(key);
    return (
      existing ?? { key, response, createdAt: now }
    );
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }
}