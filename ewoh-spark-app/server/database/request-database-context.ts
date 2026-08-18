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

/** NEST-504：根句柄回落告警去重（每实例一次，避免请求风暴刷屏日志）。 */
function warnOnce(alreadyWarned: boolean | undefined, message: string): true {
  if (!alreadyWarned) {
    // eslint-disable-next-line no-console
    console.warn(`[RequestDatabaseContext] ${message}`);
  }
  return true;
}

type StandaloneDatabase = PostgresJsDatabase<Record<string, never>>;

@Injectable()
export class RequestDatabaseContext {
  private readonly storage = new AsyncLocalStorage<StandaloneDatabase>();
  private warnedRootFallback?: boolean;

  readonly database: StandaloneDatabase;

  constructor(
    @Inject(STANDALONE_ROOT_DATABASE) private readonly rootDatabase: StandaloneDatabase,
    @Optional() private readonly slowQueryService?: SlowQueryService,
  ) {
    this.database = new Proxy({} as StandaloneDatabase, {
      get: (_target, property) => {
        let database = this.storage.getStore();
        if (!database) {
          // NEST-504 修复（2026-08-17）：无事务 store 时回落根句柄仅允许两类场景——
          // 进程启动/后台任务（无请求上下文，按 systemTransaction 约定使用）与
          // SSE 长连接（应用层 org 过滤，见 org-context.interceptor 注释）。
          // HTTP 请求上下文内的回落是租户隔离绕过（无 GUC/无 RLS）：默认告警留痕，
          // EWOH_DB_REQUIRE_TX=1 时 fail-closed 抛错（生产建议开启）。
          if (currentRequestContext() && process.env.EWOH_DB_REQUIRE_TX === '1') {
            throw new Error(
              'RequestDatabaseContext: HTTP 请求路径必须经 runInTransaction（GUC/RLS）访问数据库，检测到直接回落根句柄（NEST-504，EWOH_DB_REQUIRE_TX=1 fail-closed）',
            );
          }
          if (currentRequestContext()) {
            this.warnedRootFallback =
              warnOnce(this.warnedRootFallback, 'NEST-504: HTTP 请求上下文内无事务 store，回落根句柄（无 GUC/RLS）。请将该查询移入 runInTransaction 或经 OrgContextInterceptor 路径调用');
          }
          database = this.rootDatabase;
        }
        const value = Reflect.get(database, property, database) as unknown;
        return typeof value === 'function' ? value.bind(database) : value;
      },
    });
  }

  /**
   * Runs `operation` inside a system-level transaction on the root database
   * handle WITHOUT tenant GUC settings (no app.current_org_id / app.user_id …).
   *
   * Reserved for migrations, bootstrap, and system infrastructure that must
   * operate across org boundaries (e.g. work-orchestration durable domain state:
   * resource locks, idempotency keys, handoffs, git-sync state, evidence
   * metadata, factory replication sessions). Business requests MUST use
   * runInTransaction with the org GUC settings (or the tenant-aware
   * DRIZZLE_DATABASE proxy) so RLS and tenant isolation apply.
   *
   * Like runInTransaction, an already-active transaction is reused (one request
   * on one transaction/connection); otherwise a dedicated transaction is opened
   * on the root handle. `op` receives the transaction handle it should query on.
   */
  async systemTransaction<T>(
    op: (db: StandaloneDatabase) => Promise<T>,
  ): Promise<T> {
    return this.runInTransaction([], async () => {
      const db = this.storage.getStore() ?? this.rootDatabase;
      return op(db);
    });
  }

  /**
   * Runs `operation` as trusted system infrastructure on RLS-protected tables
   * across ALL org boundaries: sets only `app.is_global_admin='true'` (+ a
   * `system` user id for audit lineage), which makes `ewoh_org_visible()`
   * return true for every org (the DB's own global-row idiom, see
   * standalone_001 world_snapshot policies).
   *
   * P1-GUC（2026-08-19 审计）：后台系统任务（定时器/派发器）在 ALS 之外运行，
   * `this.db` 回落根句柄且无 GUC → RLS 表 `ewoh_org_visible` 恒 false →
   * 查询静默读空（不报错、数据悄悄变空）。凡后台任务必须跨 org 读写的
   * RLS 表，一律经本方法显式建立全局管理员上下文（与 systemTransaction
   * 的区别：后者无任何 GUC，仅适用于无 RLS 的表）。
   */
  async systemGlobalAdminTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.runInTransaction(
      [
        { name: 'app.user_id', value: 'system' },
        { name: 'app.is_global_admin', value: 'true' },
      ],
      operation,
    );
  }

  async runInTransaction<T>(
    settings: readonly TransactionSetting[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const thresholdMs = Number(process.env.EWOH_DB_SLOW_THRESHOLD_MS || 1000);
    // NEST-516 修复（2026-08-17）：statement timeout 缺省 30s（原默认 0=无超时，
    // 慢查询可无限占用连接池）。显式设置 EWOH_DB_STATEMENT_TIMEOUT_MS 可覆盖
    // （含设 0 关闭——运维显式决策）。
    const rawTimeout = process.env.EWOH_DB_STATEMENT_TIMEOUT_MS;
    const statementTimeoutMs =
      rawTimeout === undefined || rawTimeout === '' ? 30000 : Number(rawTimeout);
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
