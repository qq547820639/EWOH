/**
 * Task 15.2 fault-injection（e2e）：PostgreSQL 临时故障降级可观测性。
 *
 * 对运行中的 standalone API 的数据库后端连接执行 pg_terminate_backend，
 * 断言：
 *   1) 故障窗口内的请求返回结构化 5xx（Nest 全局异常过滤器 JSON error），绝不 hang；
 *   2) 下一请求自动恢复（连接池重连，返回非 5xx）；
 *   3) 恢复后调度链路功能完好。
 *
 * 运行前提：与 concurrency-real-pg.e2e.spec.ts 相同（真实 PG + standalone API）。
 * 无运行时 DB（resolveE2EConfig 返回 null）时整包 SKIP。
 */
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';

const e2eConfig = resolveE2EConfig();
const describeOrSkip = e2eConfig ? describe : describe.skip;

describeOrSkip('PostgreSQL 临时故障（Task 15.2 fault-injection）', () => {
  let owner: OwnerSql;
  let fixture: E2EFixture;
  let handle: E2EAppHandle;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    if (!e2eConfig) {
      return;
    }
    owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
    fixture = await createE2EFixture(owner);
    handle = await startE2EApp(e2eConfig, fixture.orgA.id);
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
    // explicitly configured audit owner to terminate only runtime-role
    // connections opened by this standalone app.
    const admin = postgres(e2eConfig!.ownerDatabaseUrl, { max: 1 });
    try {
      // 反复终止应用后端连接（排除本测试进程），确保故障窗口内至少一个请求命中坏连接。
      let observed5xx = false;
      for (let i = 0; i < 4 && !observed5xx; i++) {
        const backends = await admin`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND usename = 'ewoh_api'
            AND application_name = ${handle.databaseApplicationName}
            AND pid <> pg_backend_pid()
        `;
        for (const b of backends) {
          await admin`SELECT pg_terminate_backend(${b.pid})`;
        }
        const degraded = await runRequest();
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
