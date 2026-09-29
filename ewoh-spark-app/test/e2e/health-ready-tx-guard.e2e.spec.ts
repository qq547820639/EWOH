/**
 * CFG-01b（V65）常驻回归位点：就绪探针必须扛得住租户隔离兜底开关。
 *
 * 来历：链外 e2e 普查（把 `EWOH_DB_REQUIRE_TX=1` 加到非链级 spec 上跑）第一次跑到
 * `ewoh-http` 就出现两条红，其中一条正是 `GET /health/ready → 503`；同一 spec 关掉开关
 * 只剩另一条（与本档无关的 role-workbench 403）。机制：`/health/ready` 是 `@Public`，
 * 而 `OrgContextInterceptor` 只在 `request.userContext` 存在时建请求事务 ⇒ 探活的
 * `select 1` 落在"有请求上下文、无事务 store"的格子里 ⇒ 兜底一开就 fail-closed 抛错，
 * 再被原来的裸 `catch {}` 重写成"Database is not ready"。
 * 后果不是测试红，而是**按注释建议开启生产兜底的应用永远无法就绪**（K8s/CI 探针无凭证）。
 *
 * 本文件被 `verify.sh` 的 D 与 **D2**（带 `EWOH_DB_REQUIRE_TX=1`）同时执行；
 * 只有 D2 那一遍才是真正在保护这条不变量——所以它会打印自己看到的开关状态。
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

const config = resolveE2EConfig();

(config ? describe : describe.skip)(
  '就绪探针 × 租户隔离兜底 E2E（真实 PostgreSQL，@Public 身份前路径）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let adminToken = '';

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const admin = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
    }, 60_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    it('H-01 匿名 /health/ready 在兜底开关下仍返回 200（探活不许落进"无事务回落"格子）', async () => {
      const switchOn = process.env.EWOH_DB_REQUIRE_TX === '1';

      // ① 匿名探活（无 authorization）：这是 K8s/CI 探针的真实形状。
      const anon = await apiRequest<{
        status?: string;
        service?: string;
        checks?: unknown;
      }>(handle.baseUrl, '/health/ready');
      // ② liveness 不碰库，必须始终 200。
      const live = await apiRequest<{ status?: string }>(
        handle.baseUrl,
        '/health/live',
      );
      // ③ 带凭证：完整 checks，且 database 必为 ok（NEST-437 的细节收敛不受影响）。
      const detailed = await apiRequest<{
        status?: string;
        checks?: { database?: string; scheduler?: unknown };
      }>(handle.baseUrl, '/health/ready', {
        headers: jsonHeaders(adminToken),
      });

      console.log(
        `[H-01] EWOH_DB_REQUIRE_TX=${switchOn ? '1（本遍在保护该不变量）' : '未设（对照遍）'} `
        + `anon/ready=${anon.status}:${String((anon.body as { status?: string })?.status)} `
        + `live=${live.status} detailed/ready=${detailed.status}:`
        + `${String((detailed.body as { checks?: { database?: string } })?.checks?.database)}`,
      );

      expect(anon.status).toBe(200);
      expect(anon.body?.status).toBe('ok');
      // 匿名响应不得泄露内部 checks（NEST-437 既有契约，本修复不许改变它）。
      expect(anon.body?.checks).toBeUndefined();
      expect(live.status).toBe(200);
      expect(detailed.status).toBe(200);
      expect(detailed.body?.checks?.database).toBe('ok');
    }, 60_000);
  },
);
