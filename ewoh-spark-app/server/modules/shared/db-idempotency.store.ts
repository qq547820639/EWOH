import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, isNull } from 'drizzle-orm';
import { ewohIdempotencyKeys } from '@server/database/schema';
import type { IdempotencyRecord, IdempotencyStore } from './idempotency.service';

const DEFAULT_SCOPE = 'default';

/**
 * DB-backed idempotency store. Durable across restarts and instances, using the
 * unique (org_id, scope, idempotency_key) constraint to deduplicate replay / retries.
 *
 * NEST-518 修复（2026-08-17）：get/set 接受可选 scope 参数——不同业务域可使
 * 用各自 scope，同名 key 不再跨域碰撞；不传时回退 DEFAULT_SCOPE（既有行为）。
 *
 * R2-SDB-005（2026-08-18）：claim/release 原子占位——占位式 exactly-once，
 * 并发同 key 只有一个调用方执行副作用；失败释放占位允许重试。
 * R2-SDB-006（2026-08-18，standalone_060）：org_id 由列 DEFAULT 取
 * app.current_org_id GUC（无 GUC 上下文回退默认 org）；RLS
 * idempotency_org_isolation 保证 HTTP 路径租户隔离，冲突目标为复合唯一。
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
    // R2-SDB-005/006：upsert 回写终值——占位行（claim 插入的 response NULL 行）
    // 必须被更新而非被 onConflictDoNothing 跳过；冲突目标为 060 复合唯一
    // (org_id, scope, idempotency_key)。
    await this.db
      .insert(ewohIdempotencyKeys)
      .values({
        scope,
        idempotencyKey: key,
        response: response as unknown,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          ewohIdempotencyKeys.orgId,
          ewohIdempotencyKeys.scope,
          ewohIdempotencyKeys.idempotencyKey,
        ],
        set: { response: response as unknown, updatedAt: now },
      });
    const existing = await this.get<T>(key, scope);
    return (
      existing ?? { key, response, createdAt: now }
    );
  }

  /** R2-SDB-005：原子占位——INSERT pending（response NULL）onConflictDoNothing，
   * 返回是否抢占成功（仅新键/已释放键成功；终值已回写的键失败）。 */
  async claim(key: string, scope = DEFAULT_SCOPE): Promise<boolean> {
    const now = new Date();
    const inserted = await this.db
      .insert(ewohIdempotencyKeys)
      .values({
        scope,
        idempotencyKey: key,
        response: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          ewohIdempotencyKeys.orgId,
          ewohIdempotencyKeys.scope,
          ewohIdempotencyKeys.idempotencyKey,
        ],
      })
      .returning({ id: ewohIdempotencyKeys.id });
    return inserted.length > 0;
  }

  /** R2-SDB-005：执行失败释放占位（仅删 response 仍为空的 pending 行）。 */
  async release(key: string, scope = DEFAULT_SCOPE): Promise<void> {
    await this.db
      .delete(ewohIdempotencyKeys)
      .where(
        and(
          eq(ewohIdempotencyKeys.scope, scope),
          eq(ewohIdempotencyKeys.idempotencyKey, key),
          isNull(ewohIdempotencyKeys.response),
        ),
      );
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }
}
