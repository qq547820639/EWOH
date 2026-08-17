import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { ewohIdempotencyKeys } from '@server/database/schema';
import type { IdempotencyRecord, IdempotencyStore } from './idempotency.service';

const DEFAULT_SCOPE = 'default';

/**
 * DB-backed idempotency store. Durable across restarts and instances, using the
 * unique (scope, idempotency_key) constraint to deduplicate replay / retries.
 *
 * NEST-518 修复（2026-08-17）：get/set 接受可选 scope 参数——不同业务域可使
 * 用各自 scope，同名 key 不再跨域碰撞；不传时回退 DEFAULT_SCOPE（既有行为）。
 */
@Injectable()
export class DbIdempotencyStore implements IdempotencyStore {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async get<T>(key: string, scope = DEFAULT_SCOPE): Promise<IdempotencyRecord<T> | undefined> {
    const [row] = await this.db
      .select()
      .from(ewohIdempotencyKeys)
      .where(
        and(
          eq(ewohIdempotencyKeys.scope, scope),
          eq(ewohIdempotencyKeys.idempotencyKey, key),
        ),
      );
    if (!row) return undefined;
    const createdAt =
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    return { key, response: row.response as T, createdAt };
  }

  async set<T>(key: string, response: T, scope = DEFAULT_SCOPE): Promise<IdempotencyRecord<T>> {
    const now = new Date();
    await this.db
      .insert(ewohIdempotencyKeys)
      .values({
        scope,
        idempotencyKey: key,
        response: response as unknown,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const existing = await this.get<T>(key, scope);
    return (
      existing ?? { key, response, createdAt: now }
    );
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }
}