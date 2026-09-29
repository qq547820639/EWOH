/**
 * AUTH-02（V189）常驻回归位点：认证入口（Bearer → AccessTokenGuard → org 层级解析 →
 * userContext 绑定）必须扛得住租户隔离兜底开关，且层级解析结果不得被静默降级。
 *
 * 来历（§5.3el，V188）：`AccessTokenGuard` 在 `request.userContext` 赋值**之前**调
 * `orgScopeService.resolveOrgScope()`（access-token.guard.ts:59），而守卫阶段没有请求事务
 * store —— 这条 org 层级读机制上落在事务之外（开关关=回落根句柄无 GUC/RLS；开关开=
 * 抛 NEST-504 fail-closed）。守卫的 `catch`（access-token.guard.ts:62-73）会把抛错
 * **吞成"只授权主组织"**：按注释建议开启生产兜底（EWOH_DB_REQUIRE_TX=1）后，多组织
 * 用户的授权面被静默砍成单组织。V188 的 HTTP 两档不可判：production 档 WARN 被抑制、
 * 层级夹具 `update … where id=${orgId}` 影响行数为 0（token 里的 orgId 是租户 org_id，
 * 不是行主键 id）⇒ 本例把夹具效力前提变成断言，判据只看结果集，不看日志。
 *
 * 判据（不依赖日志——E2E 应用默认静默，EWOH_E2E_APP_LOGGER 才打开）：
 *   A-01 夹具效力前提：给本例私有 orgA 挂一个子组织（insert 断言影响 1 行），并用
 *        `ewoh_find_org_children`（正是 `loadChildren` 用的 SECURITY DEFINER 函数）读回，
 *        断言子组织在结果集里——V188 夹具缺的就是这一步"前提被证明"。
 *   A-02 结果集判据：Bearer 登录 → GET /api/auth/me，`accessibleOrgIds` 必须同时含
 *        主组织与子组织（长度 ≥ 2）。修复前 D2 档此处只回 [主组织] ⇒ 本用例红。
 *   A-03 守卫在场的负向对照：无 Authorization 头 → 401。证明 A-02 的结果走的是真实
 *        认证入口，而不是一条公开路由。
 *   A-04 同组织第二次解析与第一次一致（cache 命中与否不得改变授权面）。
 *
 * 本文件被 `verify.sh` 的 D 与 **D2**（带 `EWOH_DB_REQUIRE_TX=1`）同时执行；
 * 两遍都必须绿——D2 那一遍才是真正在保护"兜底开启时授权面不缩水"这条不变量。
 * 自报行刻意不复制 health-ready-tx-guard 的保留字样（开关留痕判据按日志文件精确匹配）。
 */
import { randomUUID } from 'node:crypto';
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

interface MeContext {
  userId: string;
  primaryOrgId: string;
  roles: string[];
  accessibleOrgIds: string[];
  isGlobalAdmin: boolean;
}

(config ? describe : describe.skip)(
  '认证入口 × 组织层级 × 租户隔离兜底 E2E（AUTH-02：授权面不得被静默降级）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let childOrgId = '';
    const runId = randomUUID().slice(0, 8);
    // REPRO-01 教训：不用固定 id（与并发运行/历史残留互抢）；名字带 runId 且可辨识，
    // afterAll 按 id 精确清除，崩溃残留由 A-01 的幂等预清理兜底。
    const CHILD_NAME = `EWOH E2E AuthScope Child ${runId}`;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
    }, 60_000);

    afterAll(async () => {
      try {
        if (owner && childOrgId) {
          // 只删自己这轮插进去的行；不碰 fixture 的 orgA/orgB（由 cleanupE2EFixture 负责）。
          await owner.unsafe('delete from public.ewoh_organization where id = $1::uuid', [
            childOrgId,
          ]);
        }
      } finally {
        try {
          await handle?.close();
        } finally {
          if (fixture && owner) await cleanupE2EFixture(owner, fixture);
        }
        await owner?.end();
      }
    });

    it('A-01 夹具效力前提：子组织真实落库，且 provider 用的 find_org_children 读得到它', async () => {
      // 幂等预清理：上一轮崩溃残留同名行先撤掉（影响行数允许 0）。
      await owner.unsafe('delete from public.ewoh_organization where name = $1', [
        CHILD_NAME,
      ]);
      // 夹具 orgA 的 id 与 org_id 同值（e2e-db.ts 插入 $1::uuid, $1::uuid），
      // 所以 parent_id 直接用 orgA.id 即与 find_org_children 的两个匹配臂都兼容。
      const inserted = await owner.unsafe(
        `insert into public.ewoh_organization
           (id, org_id, name, org_type, status, parent_id, _created_at, _updated_at)
         values ($1::uuid, $1::uuid, $2, 'e2e', 'active', $3::text, now(), now())
         returning id::text`,
        [randomUUID(), CHILD_NAME, fixture.orgA.id],
      );
      // V188 夹具的教训：影响行数必须断言，否则"前提没被证明"的读数会当证据用。
      expect(inserted.length).toBe(1);
      childOrgId = String((inserted[0] as unknown as { id: string }).id);

      // provider 面读回：loadChildren 走的正是这个 SECURITY DEFINER 函数
      // （org-scope.service.ts:74-88），SECURITY DEFINER ⇒ 读数与调用方角色/GUC 无关，
      // 两档开关下物理行相同、读数必然相同。
      const children = await owner.unsafe(
        'select id::text from ewoh_find_org_children($1::uuid)',
        [fixture.orgA.id],
      );
      const childIds = children.map(
        (r) => String((r as unknown as { id: string }).id),
      );
      expect(childIds).toContain(childOrgId);

      const switchOn = process.env.EWOH_DB_REQUIRE_TX === '1';
      console.log(
        `[A-01] arm=require_tx_${switchOn ? 'on' : 'off'} childOrg=${childOrgId} `
        + `find_org_children(orgA)=${childIds.length} 行（含子组织）`,
      );
    }, 60_000);

    it('A-02 结果集判据：Bearer 请求的 accessibleOrgIds 含主组织与子组织（兜底开启不得降级）', async () => {
      const session = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(session.status).toBe(201);
      const me = await apiRequest<MeContext>(handle.baseUrl, '/api/auth/me', {
        headers: jsonHeaders(session.body.accessToken),
      });
      expect(me.status).toBe(200);
      const ctx = me.body;
      expect(ctx).toBeTruthy();

      // 主组织在授权面：任何档位下的最低要求。
      expect(ctx.primaryOrgId).toBe(fixture.orgA.id);
      expect(ctx.accessibleOrgIds).toContain(fixture.orgA.id);
      // 结果集判据本体：子组织必须还在授权面里。
      // 修复前 D2 档：守卫期层级读抛 NEST-504 → catch 降级为 [主组织] ⇒ 这里红。
      expect(ctx.accessibleOrgIds).toContain(childOrgId);
      expect(ctx.accessibleOrgIds.length).toBeGreaterThanOrEqual(2);
      // 词集自洽：不出现主/子之外的身份。
      expect(new Set(ctx.accessibleOrgIds).size).toBe(ctx.accessibleOrgIds.length);

      const switchOn = process.env.EWOH_DB_REQUIRE_TX === '1';
      console.log(
        `[A-02] arm=require_tx_${switchOn ? 'on' : 'off'} `
        + `accessibleOrgIds=[${ctx.accessibleOrgIds.join(', ')}] len=${ctx.accessibleOrgIds.length}`,
      );
    }, 60_000);

    it('A-03 负向对照：无 Authorization 头必须 401（证明 A-02 走的是真实认证入口）', async () => {
      const anon = await apiRequest<unknown>(handle.baseUrl, '/api/auth/me');
      expect(anon.status).toBe(401);
      const bogus = await apiRequest<unknown>(handle.baseUrl, '/api/auth/me', {
        headers: jsonHeaders(`not-a-jwt-${runId}`),
      });
      expect(bogus.status).toBe(401);
    }, 60_000);

    it('A-04 同组织第二次解析与第一次一致（缓存命中与否不得改变授权面）', async () => {
      const first = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(first.status).toBe(201);
      const second = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(second.status).toBe(201);
      const [me1, me2] = await Promise.all([
        apiRequest<MeContext>(handle.baseUrl, '/api/auth/me', {
          headers: jsonHeaders(first.body.accessToken),
        }),
        apiRequest<MeContext>(handle.baseUrl, '/api/auth/me', {
          headers: jsonHeaders(second.body.accessToken),
        }),
      ]);
      expect(me1.status).toBe(200);
      expect(me2.status).toBe(200);
      expect([...me2.body.accessibleOrgIds].sort()).toEqual(
        [...me1.body.accessibleOrgIds].sort(),
      );
      expect(me2.body.accessibleOrgIds).toContain(childOrgId);
    }, 60_000);
  },
);
