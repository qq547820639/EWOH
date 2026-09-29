/* R-4 回归测试（2026-09-13）：PostgreSQL 连接丢失不得带走整个 API 进程。
 *
 * 现场（本机对 postgres@3.4.9 实测复现，栈与生产报障一致）：
 *   事务（drizzle `.transaction()` → postgres.js `begin()`）期间连接失效 →
 *   `begin()` 的 catch 在**已死连接**上补发 `rollback` → 驱动从裸
 *   `setImmediate(nextWrite)` 冲刷写入帧、读到 `socket === null` 抛
 *   TypeError：`Cannot read properties of null (reading 'write')`
 *   （node_modules/postgres/cjs/src/connection.js:255）。
 * 抛点不在任何 Promise 链上 ⇒ 请求侧 try/catch 与 Nest 全局过滤器都拦不到。
 *
 * 手工复现（需要可用的 PG；jest 之外单独跑）：
 *   const sql = postgres(URL, { max: 2, prepare: false });
 *   await sql.begin(async (tx) => {
 *     await tx`select pg_terminate_backend(pg_backend_pid())`;
 *     await new Promise(r => setTimeout(r, 200));
 *     await tx`select 1`;            // 事务体失败 → 驱动在死连接上回滚 → 崩溃
 *   }).catch(() => {});
 *
 * 本文件锁定三条不变量：
 *   ① 崩溃签名被**精确**识别（文案 + 驱动 nextWrite 栈帧缺一不可）；
 *   ② 连接类故障：进程存活 + 结构化留痕 + 携带 requestId；
 *   ③ 其余异常（含业务报错、同名但非驱动的 TypeError）**不被吞**，
 *      仍走 Node 默认语义，且兜底本身不得制造成功。
 */
/// <reference types="jest" />

jest.mock('@lark-apaas/fullstack-nestjs-core', () => ({
  DRIZZLE_DATABASE: Symbol('DRIZZLE_DATABASE'),
}));
jest.mock('postgres', () => ({
  __esModule: true,
  default: jest.fn(() => ({ kind: 'fake-postgres-client' })),
}));
jest.mock('drizzle-orm/postgres-js', () => ({
  drizzle: jest.fn(() => ({ kind: 'fake-drizzle' })),
}));

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { withRequestContext } from '../common/request-context';
import {
  STANDALONE_ROOT_DATABASE_PROVIDER,
  classifyProcessFault,
  installPgConnectionFaultGuard,
  isPgConnectionFault,
  isPgServerTerminationFault,
  isPgWriteRaceFault,
  pgConnectionClosedSnapshot,
  pgProcessFaultSnapshot,
  type PgFaultGuardHooks,
} from './standalone.provider';

/** 与实测栈同形：Immediate.nextWrite + 驱动 connection.js。 */
function pgWriteRaceError(): TypeError {
  const error = new TypeError("Cannot read properties of null (reading 'write')");
  error.stack =
    'TypeError: Cannot read properties of null (reading \'write\')\n' +
    '    at Immediate.nextWrite (/app/node_modules/postgres/cjs/src/connection.js:255:22)\n' +
    '    at process.processImmediate (node:internal/timers:534:21)';
  return error;
}

function driverConnectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} 127.0.0.1:55432`), { code });
}

/**
 * PostgreSQL **服务端**发出的 FATAL（形状取自 CRASH-01 实测：`pg_terminate_backend`
 * 之后驱动把 ErrorResponse 原样抛出，`code` 是五字符 SQLSTATE、不是驱动自有码）。
 */
function serverFatalError(code: string): Error {
  return Object.assign(
    new Error('terminating connection due to administrator command'),
    { code, severity: 'FATAL', severity_local: 'FATAL' },
  );
}

/** 真实安装兜底并取出它注册到 process 上的监听器（不 mock process.on）。 */
function installAndCapture(hooks: Partial<PgFaultGuardHooks> = {}) {
  const beforeUncaught = new Set(process.listeners('uncaughtException'));
  const beforeRejection = new Set(process.listeners('unhandledRejection'));
  const dispose = installPgConnectionFaultGuard(hooks);
  const uncaught = process
    .listeners('uncaughtException')
    .find((listener) => !beforeUncaught.has(listener)) as (error: unknown) => void;
  const rejection = process
    .listeners('unhandledRejection')
    .find((listener) => !beforeRejection.has(listener)) as (reason: unknown) => void;
  return { dispose, uncaught, rejection };
}

describe('R-4 崩溃签名识别', () => {
  it('命中实测栈：文案 + postgres 驱动 nextWrite 帧', () => {
    expect(isPgWriteRaceFault(pgWriteRaceError())).toBe(true);
    expect(classifyProcessFault(pgWriteRaceError())).toMatchObject({
      kind: 'pg-write-race',
      recoverable: true,
    });
  });

  it('同样文案但栈来自业务代码 → 不识别（绝不吞同名 TypeError）', () => {
    const error = new TypeError("Cannot read properties of null (reading 'write')");
    error.stack =
      'TypeError: Cannot read properties of null (reading \'write\')\n' +
      '    at ReportService.flush (/app/dist/server/modules/report/report.service.js:88:19)\n' +
      '    at /app/dist/server/main.js:12:3';
    expect(isPgWriteRaceFault(error)).toBe(false);
    expect(classifyProcessFault(error).recoverable).toBe(false);
  });

  it('栈里有驱动帧但文案不符 → 不识别（只认这一条竞态）', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'end')");
    error.stack =
      'TypeError: Cannot read properties of undefined (reading \'end\')\n' +
      '    at Immediate.nextWrite (/app/node_modules/postgres/cjs/src/connection.js:255:22)';
    expect(isPgWriteRaceFault(error)).toBe(false);
  });

  it('驱动连接错误码算连接级故障；业务错误码不算', () => {
    for (const code of ['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT']) {
      expect(isPgConnectionFault(driverConnectionError(code))).toBe(true);
      expect(classifyProcessFault(driverConnectionError(code))).toMatchObject({
        kind: 'pg-connection',
        recoverable: true,
      });
    }
    // 23505 unique_violation 是业务事实，必须原样走 Node 默认语义（退出）
    expect(isPgConnectionFault(driverConnectionError('23505'))).toBe(false);
    expect(classifyProcessFault(driverConnectionError('23505'))).toMatchObject({
      kind: 'unclassified',
      recoverable: false,
    });
    expect(classifyProcessFault(new Error('some business bug')).recoverable).toBe(false);
    expect(classifyProcessFault(undefined).recoverable).toBe(false);
  });

  /**
   * CRASH-01（V196）：兜底原来只认驱动自有码，于是数据库自己发出的 57P01 被判成"非连接类"
   * ⇒ 摘监听后原样抛出 ⇒ 终止一个在飞后端带走整个 API。这里同时钉住**放宽的边界**：
   * 只有"这条连接/这个实例此刻不可用"的四条 Class 57 码进可恢复集，库里真没了（57P04）、
   * 语句被取消（57014）、业务与完整性事实（23505/40P01）、通用 socket 码一律照旧退出。
   */
  it('服务端 Class 57 会话终止码算连接级故障；同族其它码不算', () => {
    for (const code of ['57P01', '57P02', '57P03', '57P05']) {
      expect(isPgServerTerminationFault(serverFatalError(code))).toBe(true);
      expect(isPgConnectionFault(serverFatalError(code))).toBe(true);
      expect(classifyProcessFault(serverFatalError(code))).toMatchObject({
        kind: 'pg-server-terminate',
        recoverable: true,
      });
    }
    for (const code of ['57P04', '57014', '23505', '40P01', 'ECONNRESET', 'ECONNREFUSED']) {
      expect(isPgServerTerminationFault(serverFatalError(code))).toBe(false);
      expect(classifyProcessFault(serverFatalError(code))).toMatchObject({
        kind: 'unclassified',
        recoverable: false,
      });
    }
  });
});

describe('R-4 进程级兜底（进程存活 / 留痕 / 不掩盖）', () => {
  it('连接类故障：进程继续运行，留痕并带上 requestId', async () => {
    const onRecoverable = jest.fn();
    const onUnclassified = jest.fn();
    const { dispose, uncaught } = installAndCapture({ onRecoverable, onUnclassified });
    try {
      await withRequestContext({ requestId: 'req-r4-42' }, async () => {
        uncaught(pgWriteRaceError());
      });
      expect(onUnclassified).not.toHaveBeenCalled();
      expect(onRecoverable).toHaveBeenCalledTimes(1);
      expect(onRecoverable.mock.calls[0][0]).toMatchObject({
        phase: 'uncaughtException',
        kind: 'pg-write-race',
        requestId: 'req-r4-42',
      });
    } finally {
      dispose();
    }
  });

  it('驱动连接错误码：同样只留痕不退出；无请求上下文时 requestId 为 null（不伪造）', () => {
    const onRecoverable = jest.fn();
    const onUnclassified = jest.fn();
    const { dispose, uncaught } = installAndCapture({ onRecoverable, onUnclassified });
    try {
      uncaught(driverConnectionError('CONNECTION_CLOSED'));
      expect(onUnclassified).not.toHaveBeenCalled();
      expect(onRecoverable.mock.calls[0][0]).toMatchObject({
        kind: 'pg-connection',
        requestId: null,
      });
    } finally {
      dispose();
    }
  });

  it('每次接管都计入进程级故障计数（运维据此判断抖动是否在反复推进程到悬崖边）', () => {
    const onRecoverable = jest.fn();
    const { dispose, uncaught } = installAndCapture({ onRecoverable });
    try {
      const before = pgProcessFaultSnapshot();
      uncaught(driverConnectionError('CONNECTION_CLOSED'));
      uncaught(pgWriteRaceError());
      const after = pgProcessFaultSnapshot();
      expect(after.count).toBe(before.count + 2);
      expect(after.lastKind).toBe('pg-write-race');
      expect(after.lastPhase).toBe('uncaughtException');
      expect(after.lastRequestId).toBeNull();
    } finally {
      dispose();
    }
  });

  it('unhandledRejection 走同一条判定', () => {
    const onRecoverable = jest.fn();
    const { dispose, rejection } = installAndCapture({ onRecoverable });
    try {
      rejection(pgWriteRaceError());
      expect(onRecoverable.mock.calls[0][0]).toMatchObject({ phase: 'unhandledRejection' });
    } finally {
      dispose();
    }
  });

  /**
   * CRASH-01 的实测形状：`pg_terminate_backend` 之后 57P01 以 **unhandledRejection** 到顶层。
   * 修前这条会走 onUnclassified（默认实现是"摘监听 + 原样抛出" ⇒ 进程退出，见
   * `tmp/v196-killall.log` 的 killall-2：`code=1 signal=null`）；修后只留痕、进程继续服务。
   */
  it('57P01 到顶层时进程不再被带走（只留痕，并计入故障计数）', () => {
    const onRecoverable = jest.fn();
    const onUnclassified = jest.fn();
    const { dispose, rejection } = installAndCapture({ onRecoverable, onUnclassified });
    try {
      const before = pgProcessFaultSnapshot();
      rejection(serverFatalError('57P01'));
      expect(onUnclassified).not.toHaveBeenCalled();
      expect(onRecoverable.mock.calls[0][0]).toMatchObject({
        phase: 'unhandledRejection',
        kind: 'pg-server-terminate',
      });
      expect(pgProcessFaultSnapshot().count).toBe(before.count + 1);
      expect(pgProcessFaultSnapshot().lastKind).toBe('pg-server-terminate');
      // 同一条兜底对"真缺陷"仍然不吞：紧接着一条 23505 必须走退出侧。
      rejection(serverFatalError('23505'));
      expect(onUnclassified).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('非连接类异常：默认实现先摘掉兜底再原样抛出（恢复 Node 默认退出语义）', () => {
    const onRecoverable = jest.fn();
    const { dispose, uncaught } = installAndCapture({ onRecoverable });
    expect(process.listeners('uncaughtException')).toContain(uncaught);
    let thrown: unknown;
    try {
      uncaught(new Error('业务缺陷 boom'));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error)?.message).toBe('业务缺陷 boom');
    expect(onRecoverable).not.toHaveBeenCalled();
    // 关键：抛回之前必须已经卸载自身，否则异常会在兜底里空转、进程永不出清
    expect(process.listeners('uncaughtException')).not.toContain(uncaught);
    dispose();
  });

  it('重复安装先卸载上一次（不会叠加监听器）', () => {
    const first = installAndCapture({ onRecoverable: jest.fn(), onUnclassified: jest.fn() });
    expect(process.listeners('uncaughtException')).toContain(first.uncaught);
    const second = installAndCapture({ onRecoverable: jest.fn(), onUnclassified: jest.fn() });
    try {
      expect(process.listeners('uncaughtException')).not.toContain(first.uncaught);
      expect(process.listeners('uncaughtException')).toContain(second.uncaught);
    } finally {
      second.dispose();
    }
  });

  it('卸载函数幂等', () => {
    const { dispose, uncaught } = installAndCapture({ onRecoverable: jest.fn() });
    dispose();
    dispose();
    expect(process.listeners('uncaughtException')).not.toContain(uncaught);
  });
});

describe('R-4 连接关闭可观测（provider 装配）', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSudaUrl = process.env.SUDA_DATABASE_URL;

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SUDA_DATABASE_URL = originalSudaUrl;
    jest.clearAllMocks();
  });

  it('缺少连接串时显式失败，不静默回落默认连接', () => {
    delete process.env.DATABASE_URL;
    delete process.env.SUDA_DATABASE_URL;
    expect(() => STANDALONE_ROOT_DATABASE_PROVIDER.useFactory()).toThrow(/DATABASE_URL is required/);
    expect(drizzle).not.toHaveBeenCalled();
  });

  it('注册 onclose：连接关闭计数 + 留痕，不静默（措辞不越权定性）', () => {
    process.env.DATABASE_URL = 'postgresql://user:pw@127.0.0.1:55432/ewoh';
    STANDALONE_ROOT_DATABASE_PROVIDER.useFactory();

    expect(drizzle).toHaveBeenCalledTimes(1);
    const call = (postgres as unknown as jest.Mock).mock.calls[0] as [string, { onclose?: (id: number) => void }];
    expect(call[0]).toBe('postgresql://user:pw@127.0.0.1:55432/ewoh');
    expect(typeof call[1].onclose).toBe('function');

    const before = pgConnectionClosedSnapshot();
    call[1].onclose?.(7);
    const after = pgConnectionClosedSnapshot();
    expect(after.count).toBe(before.count + 1);
    expect(after.lastConnectionId).toBe(7);
    expect(after.lastCause).toBe('CONNECTION_CLOSED');
    expect(after.lastAt).not.toBeNull();
  });
});
