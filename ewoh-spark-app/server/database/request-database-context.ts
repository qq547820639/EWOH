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

/** 只读形态的事务设置（调用方可传自有字面量数组，无需依赖本模块的具体类型）。 */
export type TransactionSettingLike = TransactionSetting;

/** NEST-504：根句柄回落告警去重（每实例一次，避免请求风暴刷屏日志）。 */
function warnOnce(alreadyWarned: boolean | undefined, message: string): true {
  if (!alreadyWarned) {
    // eslint-disable-next-line no-console
    console.warn(`[RequestDatabaseContext] ${message}`);
  }
  return true;
}

/**
 * CFG-01c 观测点（2026-09-24，链行为基线）：默认关闭、零语义影响；`EWOH_DB_NEST504_TRACE=1` 时
 * 给"HTTP 请求上下文内无事务 store 回落根句柄"这条分支补**按调用点去重**的溯源留痕，回答登记册
 * 三问里"这 11 次是谁发的（同一条还是 N 条不同路径）""有没有真需要事务边界的请求路径"。
 * warnOnce 是每实例一次的布尔，看不见具体查询；这里以调用帧为键、每种路径只报一次。
 * 与 RUN-01 观测同一手法（默认不改变行为），不改生产日志量。
 */
const nest504TracedCallers = new Set<string>();
function traceRootFallbackCaller(requestId: string | undefined): void {
  if (process.env.EWOH_DB_NEST504_TRACE !== '1') return;
  const frames = (new Error().stack || '').split('\n');
  const caller = frames.find((f) =>
    /server[\\/](modules|common|database)[\\/]/.test(f) && !/request-database-context/.test(f));
  const key = (caller || frames[3] || '(no-frame)').trim();
  if (nest504TracedCallers.has(key)) return;
  nest504TracedCallers.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[NEST504-TRACE] req=${requestId ?? '-'} distinct-callers=${nest504TracedCallers.size} caller=${key}`);
}

type StandaloneDatabase = PostgresJsDatabase<Record<string, never>>;

/**
 * RUN-01 观测点（2026-09-21，链行为基线 §5.3h）：**已结束的事务被后来的续作 join** 这一形状。
 *
 * 实测成因：处理器里不 await 的续作在响应返回后才继续跑，而 AsyncLocalStorage 仍带着
 * 请求事务的 store；`runInTransaction` 的「已有 store 就加入、不开 savepoint」于是把续作
 * 挂到那个**已经 COMMIT/ROLLBACK** 的事务上 → 表现是静默挂死或写入丢失（无异常、无日志）。
 * 产品侧的修复是让续作自带事务；这里补的是**发现能力**：一旦再出现同类写法，日志里必须有名字。
 *
 * 只观测不改变语义：不在这里抛错——同一进程里哪些路径会撞上它尚未穷尽测量（全仓 50+ 处非 await
 * 调用点），把观测变成新故障源违背「先复现再改」。EWOH_DB_RUN01_THROW=1 可显式升级为抛错。
 */
const settledTransactions = new WeakSet<object>();
const settledJoinReported = new WeakSet<object>();

function markTransactionSettled(tx: object): void {
  settledTransactions.add(tx);
}

function warnIfJoinedAfterSettle(tx: object): void {
  if (!settledTransactions.has(tx) || settledJoinReported.has(tx)) return;
  settledJoinReported.add(tx);
  // eslint-disable-next-line no-console
  console.error(
    '[RequestDatabaseContext] RUN-01：请求事务已结束，仍有续作 join 到同一 store'
    + '（该写入可能挂住或丢失）。修法=把这段续作改为 runDetachedTransaction，'
    + '见基线文档 §5.3h。EWOH_DB_RUN01_THROW=1 可把本观测升级为抛错。',
  );
  if (process.env.EWOH_DB_RUN01_THROW === '1') {
    throw new Error('RUN-01: joined a settled request transaction');
  }
}

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
            traceRootFallbackCaller(currentRequestContext()?.requestId);
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

  /**
   * NO-62a：**脱离当前请求事务**地提交一段写入（独立连接 + 独立事务）。
   *
   * 为什么必须有它（本轮实测抓到的真缺陷）：`OrgContextInterceptor` 把每个 HTTP 请求
   * 包在一个事务里执行；**handler 抛异常 → 整个请求事务回滚**。
   * 于是"安全决策 + 抛 409/404"这种最需要留痕的路径，恰恰会把刚刚写下的
   * 撤回/审计/结果行一起回滚掉（实测：投递前授权复核判定拒绝 → 命令撤回写入
   * 被 409 带走，命令留在 `sent`，下一轮还会被投递）。
   *
   * 语义边界（不要滥用）：
   *   · 只用于**错误/拒绝路径上必须存活**的事实：撤回、拒绝留痕、补偿事件；
   *   · 以及**活过请求的续作**（RUN-01，2026-09-21 实测）：处理器里不 await 的异步续作
   *     在响应返回之后才继续跑，那时请求事务已经提交/回滚，而 ALS store 仍挂在续作上；
   *     `runInTransaction` 的"已有 store 就加入、且不开 savepoint"语义会把续作
   *     挂到那个**已结束**的事务上。实测两种形态：ingest 故障重排留下永不闭合的
   *     `queued` run（有触发记录、无方案、无日志）；任务写桥接则连触发去重记录都不产生
   *     （0 行 0 日志，静默丢失）。这类续作必须自带事务。
   *   · 副作用要说清：续作读不到发起方**尚未提交**的写入，它看到的是上一个已提交世界态
   *     （自动重排因此基于"已提交世界"而非"在途批次"——这是刻意的，两阶段互不回滚）。
   *   · 正常同步成功路径一律走 `runInTransaction`（同请求同事务，保证原子性）；
   *   · 它开的是**新连接**：调用方不得在同一操作里依赖外层的行锁或未提交读，
   *     也不得写入与外层事务存在锁序冲突的行。
   *   · 通过 `storage.run(newTx, …)` 建立新上下文：内部用 DRIZZLE_DATABASE 代理
   *     拿到的仍是这个新事务（GUC/RLS 生效），不会掉进"根句柄无 GUC"的静默空读陷阱。
   */
  async runDetachedTransaction<T>(
    settings: readonly TransactionSetting[],
    operation: (db: StandaloneDatabase) => Promise<T>,
  ): Promise<T> {
    let openedTransaction: StandaloneDatabase | undefined;
    const running = this.rootDatabase.transaction(async (transaction) => {
      openedTransaction = transaction as unknown as StandaloneDatabase;
      for (const setting of settings) {
        await transaction.execute(
          sql`select set_config(${setting.name}, ${setting.value}, true)`,
        );
      }
      return this.storage.run(
        transaction as unknown as StandaloneDatabase,
        () => operation(transaction as unknown as StandaloneDatabase),
      );
    });
    return running.finally(() => {
      if (openedTransaction) markTransactionSettled(openedTransaction as unknown as object);
    });
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
        // RUN-01 观测：store 已结束 = 这是一段活过请求的续作（详见 settledTransactions 注释）。
        warnIfJoinedAfterSettle(activeTransaction as unknown as object);
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

      let openedTransaction: StandaloneDatabase | undefined;
      const running = this.rootDatabase.transaction(async (transaction) => {
        openedTransaction = transaction as unknown as StandaloneDatabase;
        for (const setting of effectiveSettings) {
          await transaction.execute(
            sql`select set_config(${setting.name}, ${setting.value}, true)`,
          );
        }

        return this.storage.run(transaction as unknown as StandaloneDatabase, operation);
      });
      // 注意：不能用外层 try/finally 来标记——`return promise` 会立刻触发 finally，
      // 那时事务还没结束。必须挂在 promise 自身上（提交/回滚都算 settle）。
      return running.finally(() => {
        if (openedTransaction) markTransactionSettled(openedTransaction as unknown as object);
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
