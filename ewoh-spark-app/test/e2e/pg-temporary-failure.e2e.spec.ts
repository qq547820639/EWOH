/**
 * Task 15.2 fault-injection（e2e）：PostgreSQL 临时故障降级可观测性。
 *
 * 对运行中的 standalone API 的数据库后端连接执行 pg_terminate_backend，
 * 断言：
 *   1) 故障窗口内的请求返回结构化 5xx（Nest 全局异常过滤器 JSON error），绝不 hang；
 *   2) 下一请求自动恢复（连接池重连，返回非 5xx）；
 *   3) 恢复后调度链路功能完好。
 *
 * 运行前提：真实 PG。无运行时 DB（resolveE2EConfig 返回 null）时整包 SKIP。
 *
 * 为什么 standalone API 必须是**子进程**（2026-09-18）：
 *   用例注入的是进程级故障 —— 终止在飞事务的连接会命中 postgres@3.4.9 的
 *   write/close 竞态，驱动把 `TypeError: Cannot read properties of null
 *   (reading 'write')` 抛在裸 setImmediate 上（脱离任何 Promise 链）。
 *   生产形态由 server/main.ts bootstrap 安装的 installPgConnectionFaultGuard
   * 接管（进程存活、留痕，请求按 5xx 失败）。若应用与 jest 同进程，
 *   jest-circus 会在每个用例开始时摘掉真实 process 上的全部
 *   uncaughtException 监听器、只留自己的记账器（jestAdapter 传
 *   parentProcess: process），驱动竞态异常必然被记为用例失败 —— 测试环境内
 *   （副本 process）注册的任何 handler 都拦不住。子进程形态让该用例回到
 *   其文档写明的前提「对运行中的 standalone API 注入故障」，产品 R-4 兜底
 *   在真实 process 上按生产行为生效；断言集与原实现完全一致。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';

const e2eConfig = resolveE2EConfig();
const describeOrSkip = e2eConfig ? describe : describe.skip;

/** 子进程 standalone API 句柄（与 startE2EApp 的 handle 同形的最小子集）。 */
interface StandaloneChild {
  baseUrl: string;
  databaseApplicationName: string;
  close(): Promise<void>;
}

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 以生产形态（dist/server/main.js bootstrap）拉起 standalone API 子进程。
 * 进程级 PgFaultGuard 由该入口自行安装（与部署一致），本函数只负责
 * env 装配、就绪等待与退出回收。
 */
async function startStandaloneChild(
  config: NonNullable<ReturnType<typeof resolveE2EConfig>>,
  simulatorOrgId: string,
): Promise<StandaloneChild> {
  const port = await freeTcpPort();
  const databaseApplicationName = `ewoh-e2e-${randomUUID().slice(0, 12)}`;
  const databaseUrl = new URL(config.runtimeDatabaseUrl);
  databaseUrl.searchParams.set('application_name', databaseApplicationName);

  const entry = path.resolve(__dirname, '../../dist/server/main.js');
  let stderrTail = '';
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      EWOH_DEPLOY_TARGET: 'standalone',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl.toString(),
      JWT_SECRET: config.jwtSecret,
      REFRESH_TOKEN_EXPIRES_IN: config.refreshTokenExpiresIn,
      RATE_LIMIT_MAX: config.rateLimitMax,
      LOGIN_RATE_LIMIT_MAX: '10000',
      // 摄入网关 fail-closed（P1-INGEST-002）：与 startE2EApp 相同的测试侧装配。
      INGEST_API_KEY: 'e2e-ingest-key',
      INGEST_RATE_LIMIT: '100000',
      INGEST_INSECURE_DEV_MODE: 'true',
      EWOH_SIMULATOR_ORG_ID: simulatorOrgId,
      EWOH_SIMULATOR_DISABLED: '1',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const close = async (): Promise<void> => {
    if (child.exitCode != null || child.signalCode != null) {
      child.stderr?.destroy();
      return;
    }
    // Always await the same exit event, including after SIGKILL escalation.
    // Closing stdio prevents Jest from waiting on a detached child's pipe handles.
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
    if (!graceful) child.kill('SIGKILL');
    await exited;
    child.stderr?.destroy();
  };

  // 就绪等待：任意 HTTP 响应（含 404/503）即视为监听已建立。
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `standalone child exited early (code=${child.exitCode})\n${stderrTail}`,
      );
    }
    try {
      await fetch(`${baseUrl}/health/live`);
      return { baseUrl, databaseApplicationName, close };
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  await close();
  throw new Error(
    `standalone child did not become ready: ${String(lastError)}\n${stderrTail}`,
  );
}

describeOrSkip('PostgreSQL 临时故障（Task 15.2 fault-injection）', () => {
  let owner: OwnerSql;
  let fixture: E2EFixture;
  let handle: StandaloneChild;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    if (!e2eConfig) {
      return;
    }
    owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
    fixture = await createE2EFixture(owner);
    handle = await startStandaloneChild(e2eConfig, fixture.orgA.id);
    baseUrl = handle.baseUrl;
    const loginRes = await login(
      baseUrl,
      fixture.dispatcherA.username,
      fixture.dispatcherA.password,
    );
    expect(loginRes.status).toBe(201);
    token = loginRes.body.accessToken;
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (owner) {
      if (fixture) await cleanupE2EFixture(owner, fixture);
      await owner.end();
    }
  });

  function runRequest() {
    return apiRequest(baseUrl, '/api/scheduler/runs', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        strategy: 'scheduling_v2',
        trigger: 'TASK_UPDATED',
      }),
    });
  }

  it('终止应用 DB 后端连接 → 结构化 5xx（不 hang、不吞错）；下一请求自动恢复', async () => {
    // 基线：故障前请求成功（非 5xx）。
    const baseline = await runRequest();
    expect(baseline.status).toBeLessThan(500);

    const postgres = (await import('postgres')).default;
    // The runtime role is deliberately denied pg_signal_backend. Use the
    // explicitly configured audit owner to terminate only runtime connections
    // opened by this standalone app. The runtime role name follows the runtime
    // DATABASE_URL（ewoh_api 部署形态 / 本地 owner 直连形态均可），配合本实例
    // 唯一的 application_name 精确瞄准，绝不误伤其它会话。
    const runtimeUser = decodeURIComponent(
      new URL(e2eConfig!.runtimeDatabaseUrl).username,
    );
    const admin = postgres(e2eConfig!.ownerDatabaseUrl, { max: 1 });
    try {
      // 反复终止应用后端连接（排除本测试进程），确保故障窗口内至少一个请求命中坏连接。
      // 先发起请求再终止：请求经 OrgContextInterceptor 包装为单个事务，在飞窗口内
      // 其后端被终止 → 连接级故障 → 子进程内 R-4 兜底接管（驱动 rollback 竞态），
      // 请求以结构化 5xx 失败。若先终止后请求，postgres.js 会静默重连（池重建），
      // 请求反而可能不受影响 —— 注入窗口必须与在飞请求重叠才可观测。
      let observed5xx = false;
      for (let i = 0; i < 4 && !observed5xx; i++) {
        const inFlight = runRequest();
        // 等待请求进入在飞事务（基线单次请求耗时数百 ms，30ms 足够越过鉴权进入 DB 段）。
        await delay(30);
        const backends = await admin`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND usename = ${runtimeUser}
            AND application_name = ${handle.databaseApplicationName}
            AND pid <> pg_backend_pid()
        `;
        for (const b of backends) {
          await admin`SELECT pg_terminate_backend(${b.pid})`;
        }
        const degraded = await inFlight;
        if (degraded.status >= 500) {
          observed5xx = true;
          // 15.6：降级可观测 —— 结构化 JSON error（非 hang、非无痕成功）。
          expect(degraded.body).toHaveProperty('error');
          expect(typeof (degraded.body as { error: unknown }).error).toBe(
            'object',
          );
          const error = (
            degraded.body as {
              error: { code?: string; message?: string };
            }
          ).error;
          expect(typeof error.code).toBe('string');
          expect(typeof error.message).toBe('string');
        }
      }
      expect(observed5xx).toBe(true);
    } finally {
      await admin.end();
    }

    // 恢复：不再终止连接，等待连接池重连后请求恢复（非 5xx）。
    await new Promise((r) => setTimeout(r, 500));
    const recovered = await runRequest();
    expect(recovered.status).toBeLessThan(500);
  }, 60_000);
});
