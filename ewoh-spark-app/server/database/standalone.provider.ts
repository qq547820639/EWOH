import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { currentRequestContext } from '../common/request-context';
import {
  RequestDatabaseContext,
  STANDALONE_ROOT_DATABASE,
} from './request-database-context';

const faultLogger = new Logger('PgConnectionFault');

/* ==================================================================== *
 * R-4（2026-09-13）：PostgreSQL 连接丢失会带走整个 API 进程。
 *
 * 现场（本机对 postgres@3.4.9 实测复现，与生产报障栈完全一致）：
 *   · 事务（drizzle `.transaction()` → postgres.js `begin()`）期间连接失效，
 *     `begin()` 的 catch 会在**已死连接**上补发 `rollback`；
 *   · 连接的 socket 已被 `closed()` 置为 null，但驱动仍从裸
 *     `setImmediate(nextWrite)` 里冲刷写入帧 → `socket.write` 读到 null 抛
 *     TypeError；
 *   · 抛点不在任何 Promise 链上 ⇒ 请求侧 try/catch 与 Nest 全局异常过滤器
 *     都拦不到 ⇒ Node 默认行为**直接终止进程**。一条坏连接带走整个 API。
 *
 * 这里做两件事，都刻意"不掩盖问题"：
 *   1. 连接关闭可观测（onclose 计数 + 结构化日志）——运维能区分
 *      "PG 故障转移/连接回收"与"应用缺陷"；
 *   2. 进程级兜底——**仅**在确认为连接类故障时让进程存活；其余异常一律
 *      恢复 Node 默认语义（打印 + 退出），绝不把未知缺陷当成连接抖动吞掉。
 *
 * 纪律：本兜底只保证"进程不死"。数据库不可用仍必须以 5xx 暴露给调用方，
 * 绝不允许被读作空结果或业务成功（见 GlobalExceptionFilter 的未知异常分支）。
 * ==================================================================== */

/**
 * 连接关闭计数快照（观测面；不落库、不跨进程聚合）。
 *
 * 刻意叫 "closed" 而不是 "fault"：驱动只告诉我们"这条连接关了"，
 * 分不清是 PG 侧故障转移/空闲回收、网络抖动，还是进程退出时池的正常
 * 收尾（`client.end()` 也会触发 onclose）。指标名照实描述事实，
 * 具体定性交给日志里的 cause 与现场判断——不替运维下结论。
 */
export interface PgConnectionClosedSnapshot {
  count: number;
  lastAt: string | null;
  lastConnectionId: number | null;
  lastCause: string;
}

const connectionClosedState: PgConnectionClosedSnapshot = {
  count: 0,
  lastAt: null,
  lastConnectionId: null,
  lastCause: '',
};

export function pgConnectionClosedSnapshot(): PgConnectionClosedSnapshot {
  return { ...connectionClosedState };
}

/**
 * 记录一次连接关闭（PG 侧 terminate、故障转移、空闲回收、网络抖动、池收尾）。
 *
 * 为什么必须显式记录：postgres.js 对断连是**静默自愈**的（下一条查询由池
 * 重建连接），不登记就只剩零散 5xx，运维无法区分"数据库正在被摘除"与
 * "某个接口有缺陷"；也无法判断故障是孤例还是持续。
 *
 * 措辞只陈述已确知的事实（某条连接关闭了），不断言"故障"——进程退出阶段的
 * 正常关闭走的是同一个回调，把两者混为一谈就是伪造信号。
 */
export function notePgConnectionClosed(connectionId: number | null, cause: string): void {
  connectionClosedState.count += 1;
  connectionClosedState.lastAt = new Date().toISOString();
  connectionClosedState.lastConnectionId = connectionId;
  connectionClosedState.lastCause = cause;
  const requestId = currentRequestContext()?.requestId ?? '-';
  faultLogger.warn(
    `pg_connection_closed_total=${connectionClosedState.count} connection=${connectionId ?? '-'} ` +
      `requestId=${requestId} cause=${cause}` +
      `（该连接已失效：落在它身上的查询必须以 5xx 失败，严禁回落为空结果/默认值；` +
      `若为进程退出阶段的池收尾不影响服务）`,
  );
}

/**
 * 判定「postgres 驱动 write/close 竞态」这一条**精确**签名。
 *
 * 必须同时命中报错文案与驱动栈帧两条：
 *   · 只看文案会把业务代码里同名的 TypeError 一并吞掉（掩盖真缺陷）；
 *   · 只看栈帧会把驱动其它可修复错误误判为可恢复。
 * 文案直译：socket 已置空，仍在冲刷已缓冲的写入帧。
 */
export function isPgWriteRaceFault(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (!/Cannot read propert(?:y|ies) of (?:null|undefined) \(reading 'write'\)/.test(error.message)) {
    return false;
  }
  const stack = error.stack ?? '';
  // 驱动栈形如 .../node_modules/postgres/cjs/src/connection.js:255:22 + Immediate.nextWrite
  return /[\\/]postgres[\\/]/.test(stack) && /\bnextWrite\b/.test(stack);
}

/**
 * postgres 驱动自有的连接级错误码（见 postgres/src/errors.js）。
 * 刻意**只**收驱动产出的码，不收 ECONNRESET 之类的通用 socket 码：
 * 后者可能来自任何出站 HTTP 调用，用它判定"数据库不可用"会张冠李戴。
 */
const PG_CONNECTION_ERROR_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/**
 * PostgreSQL **服务端**发出的 Class 57（operator_intervention）会话/连接级 SQLSTATE。
 * 名字与语义取自官方文档附录 A.1（"PostgreSQL Error Codes"，Table A.1）：
 *   57P01 admin_shutdown · 57P02 crash_shutdown · 57P03 cannot_connect_now · 57P05 idle_session_timeout
 *
 * 为什么单独一组、且为什么敢让它活下来：通用 socket 码（ECONNRESET）可能来自任何出站调用，
 * 拿它判"数据库抖动"会张冠李戴；而五字符 SQLSTATE **只可能由 PostgreSQL 自己产出**，
 * 这四条码说的都是"这条连接／这个实例此刻不可用"，不是任何业务事实。CRASH-01 的实测形状
 * 就是 57P01：终止一个在飞后端 ⇒ 该 FATAL 以 unhandledRejection 形态到顶层，被旧判据归成
 * "非连接类"⇒ 摘监听后原样抛出 ⇒ 整个 API 一起消失（tmp/v196-killall.log 的 killall-2）。
 *
 * 刻意**不收**：57P04 database_dropped（这个库真没了，不是抖动，交给编排层重启才是正解）、
 * 57014 query_canceled（语句级取消，属请求侧事实，应在请求路径里被判掉），
 * 以及其余一切 SQLSTATE（23505／40P01…都是业务或完整性事实）。
 */
const PG_SERVER_TERMINATION_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '57P05',
]);

/** 是否为 PostgreSQL 服务端发出的会话终止类 SQLSTATE（只认上面那四条）。 */
export function isPgServerTerminationFault(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && PG_SERVER_TERMINATION_CODES.has(code);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : null;
}

/** 是否为连接级故障：驱动自有码、服务端 Class 57 会话终止码，或驱动写/关竞态。 */
export function isPgConnectionFault(error: unknown): boolean {
  if (isPgWriteRaceFault(error) || isPgServerTerminationFault(error)) {
    return true;
  }
  const code = errorCode(error);
  return code !== null && PG_CONNECTION_ERROR_CODES.has(code);
}

export type PgFaultKind =
  | 'pg-write-race'
  | 'pg-connection'
  | 'pg-server-terminate'
  | 'unclassified';

export interface ProcessFaultClassification {
  kind: PgFaultKind;
  recoverable: boolean;
  reason: string;
}

/**
 * 把任意进程级异常分类为"连接类可恢复"或"必须按默认语义终止"。
 * 分类器刻意窄：拿不准一律 unclassified（宁可退出，也不吞掉未知缺陷）。
 */
export function classifyProcessFault(error: unknown): ProcessFaultClassification {
  if (isPgWriteRaceFault(error)) {
    return {
      kind: 'pg-write-race',
      recoverable: true,
      reason: 'postgres@3.4.9 write/close 竞态：socket 置空后仍冲刷写入帧（连接已失效，非业务缺陷）',
    };
  }
  const code = errorCode(error);
  if (code !== null && PG_SERVER_TERMINATION_CODES.has(code)) {
    return {
      kind: 'pg-server-terminate',
      recoverable: true,
      reason: `PostgreSQL 服务端会话终止码 code=${code}（Class 57，只可能来自数据库本身）`,
    };
  }
  if (code !== null && PG_CONNECTION_ERROR_CODES.has(code)) {
    return {
      kind: 'pg-connection',
      recoverable: true,
      reason: `PostgreSQL 连接级错误 code=${code}`,
    };
  }
  return { kind: 'unclassified', recoverable: false, reason: '非连接类异常，保持 Node 默认语义' };
}

export type ProcessFaultPhase = 'uncaughtException' | 'unhandledRejection';

export interface RecoverablePgFault {
  phase: ProcessFaultPhase;
  kind: Exclude<PgFaultKind, 'unclassified'>;
  requestId: string | null;
  reason: string;
  error: unknown;
}

/** 已接管的进程级故障快照（进程存活事件；每接管一次 +1）。 */
export interface PgProcessFaultSnapshot {
  count: number;
  lastAt: string | null;
  lastKind: PgFaultKind;
  lastPhase: ProcessFaultPhase | null;
  lastRequestId: string | null;
}

const processFaultState: PgProcessFaultSnapshot = {
  count: 0,
  lastAt: null,
  lastKind: 'unclassified',
  lastPhase: null,
  lastRequestId: null,
};

/**
 * 已接管的进程级故障快照。为什么单独计数：这是"进程本该已死但活下来了"
 * 的次数——它不体现在任何一次请求的 5xx 上（那些 5xx 会被记成普通错误），
 * 运维靠它才能判断"数据库抖动是否正在反复把进程推到悬崖边"。
 */
export function pgProcessFaultSnapshot(): PgProcessFaultSnapshot {
  return { ...processFaultState };
}

function noteRecoveredProcessFault(fault: RecoverablePgFault): void {
  processFaultState.count += 1;
  processFaultState.lastAt = new Date().toISOString();
  processFaultState.lastKind = fault.kind;
  processFaultState.lastPhase = fault.phase;
  processFaultState.lastRequestId = fault.requestId;
}

export interface PgFaultGuardHooks {
  /** 连接级故障：已留痕，进程继续运行（请求侧仍按 5xx 失败）。 */
  onRecoverable(fault: RecoverablePgFault): void;
  /** 其余异常：保持 Node 默认语义。默认实现 = 摘掉自身监听后原样抛出。 */
  onUnclassified(error: unknown, phase: ProcessFaultPhase, restoreDefault: () => void): void;
}

let disposeInstalledGuard: (() => void) | null = null;

/**
 * 安装进程级兜底。返回卸载函数（测试/关停用；重复安装会先卸载上一次）。
 *
 * 语义边界（务必保持）：
 *   · **只**接管 uncaughtException / unhandledRejection 中的连接类故障；
 *   · 非连接类异常走 onUnclassified —— 默认实现摘掉本兜底再原样抛出，
 *     于是 Node 默认的"打印 + 退出码 1"语义完全保留（不会因为多了兜底
 *     就让真缺陷留在进程里继续跑）。
 *   · 兜底**不**制造成功：连接失效的请求该失败就失败（postgres.js 会把
 *     在飞的查询以 CONNECTION_* 拒绝，由全局过滤器如实回 5xx）。
 */
export function installPgConnectionFaultGuard(hooks: Partial<PgFaultGuardHooks> = {}): () => void {
  disposeInstalledGuard?.();

  const restores: Array<() => void> = [];
  const restoreDefault = (): void => {
    for (const restore of restores.splice(0)) {
      restore();
    }
    if (disposeInstalledGuard === restoreDefault) {
      disposeInstalledGuard = null;
    }
  };

  const onRecoverable =
    hooks.onRecoverable ??
    ((fault: RecoverablePgFault): void => {
      faultLogger.error(
        `[PgFaultGuard] ${fault.phase} 命中连接级故障 kind=${fault.kind} ` +
          `pg_process_fault_recovered_total=${processFaultState.count}，进程继续运行；` +
          `该请求应按 5xx 失败，严禁当作业务成功。requestId=${fault.requestId ?? '-'} reason=${fault.reason}`,
      );
    });

  const onUnclassified =
    hooks.onUnclassified ??
    ((error: unknown, phase: ProcessFaultPhase, restore: () => void): void => {
      const stack = error instanceof Error ? error.stack : String(error);
      faultLogger.error(
        `[PgFaultGuard] ${phase} 非连接类异常，保持 Node 默认语义（进程退出）`,
        stack,
      );
      restore();
      // 摘掉监听后再抛出 ⇒ 回到 Node 原生"打印 + 退出码 1"路径。
      throw error;
    });

  const handle = (phase: ProcessFaultPhase, payload: unknown): void => {
    const classification = classifyProcessFault(payload);
    if (classification.recoverable) {
      const fault: RecoverablePgFault = {
        phase,
        kind: classification.kind as Exclude<PgFaultKind, 'unclassified'>,
        requestId: currentRequestContext()?.requestId ?? null,
        reason: classification.reason,
        error: payload,
      };
      // 计数在分发之前记：换掉 onRecoverable 实现（测试/定制）也不能漏掉可观测量。
      noteRecoveredProcessFault(fault);
      onRecoverable(fault);
      return;
    }
    onUnclassified(payload, phase, restoreDefault);
  };

  const onUncaughtException = (error: unknown): void => handle('uncaughtException', error);
  const onUnhandledRejection = (reason: unknown): void => handle('unhandledRejection', reason);

  process.on('uncaughtException', onUncaughtException);
  restores.push(() => process.removeListener('uncaughtException', onUncaughtException));
  process.on('unhandledRejection', onUnhandledRejection);
  restores.push(() => process.removeListener('unhandledRejection', onUnhandledRejection));

  disposeInstalledGuard = restoreDefault;
  return restoreDefault;
}

export const STANDALONE_ROOT_DATABASE_PROVIDER = {
  provide: STANDALONE_ROOT_DATABASE,
  useFactory: () => {
    const url = process.env.DATABASE_URL || process.env.SUDA_DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required in standalone mode');
    }
    const poolMax = Number(process.env.DB_POOL_MAX || 20);
    // NEST-524（2026-08-17）：SSL 显式化。连接串含 sslmode 参数时由 postgres
    // 按串处理；否则 DB_SSL=require 时启用 TLS（生产建议在入口对数据库强制
    // sslmode=require，避免明文链路）。DB_SSL=verify 时校验服务端证书。
    const sslMode = process.env.DB_SSL;
    const ssl =
      sslMode === 'require'
        ? { rejectUnauthorized: false }
        : sslMode === 'verify'
          ? { rejectUnauthorized: true }
          : undefined;
    const client = postgres(url, {
      max: poolMax,
      idle_timeout: Number(process.env.DB_POOL_IDLE_TIMEOUT || 30000),
      connect_timeout: 10,
      prepare: false,
      ...(ssl ? { ssl } : {}),
      // R-4（2026-09-13）：连接关闭可观测。postgres.js 对断连是静默自愈的
      // （下一条查询由池重建连接），不登记就只剩零散 5xx，运维无法区分
      // "PG 故障转移/连接被服务端回收"与"某个接口有缺陷"。
      // onclose 是唯一能观测到"空闲连接被服务端摘掉"的位置（reserved 与在飞
      // 连接走 reconnect 分支，不触发该回调）。
      onclose: (connectionId: number) => notePgConnectionClosed(connectionId, 'CONNECTION_CLOSED'),
    });
    return drizzle(client);
  },
};

export const STANDALONE_DATABASE_PROVIDER = {
  provide: DRIZZLE_DATABASE,
  inject: [RequestDatabaseContext],
  useFactory: (context: RequestDatabaseContext) => context.database,
};
