import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
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

if (!e2eConfig) {
  describe.skip('Cross-org RLS GUC runtime E2E (skipped)', () => {
    it('requires a runtime DATABASE_URL', () => {
      expect(e2eConfig).not.toBeNull();
    });
  });
} else {
  /**
   * 跨租户 RLS 运行时断言（7.4）：
   *  - 真实 PG 下向 RLS 表 ewoh_scheduling_constraint（standalone_025 启用 RLS，
   *    策略读 app.current_org_id，org_id IS NULL 全局放行）为 org A / org B 播种行；
   *  - 并发（Promise.all）以 org A / org B 身份请求同一 org-scoped 端点
   *    GET /api/scheduler/plans/:planId/constraints，断言各自只看到自己的行
   *    （+ 全局 NULL 行），绝不看到对方行；
   *  - 以应用角色连接（非 bypass 的 service_role）在事务内 set_config
   *    app.current_org_id 后直接查表，断言 RLS 策略真实过滤行（含未知 org → 只
   *    剩全局行，证明 RLS 未被绕过）。
   */
  describe('Cross-org RLS: GUC row filtering + concurrent HTTP isolation', () => {
    const runId = randomUUID().slice(0, 8);
    let owner: OwnerSql | undefined;
    let fixture: E2EFixture | undefined;
    let handle: E2EAppHandle | undefined;
    let baseUrl = '';
    let runtimeClient: ReturnType<typeof postgres> | undefined;
    const planId = `PLAN-RLS-${runId}`;
    const constraintA = `CON-A-${runId}`;
    const constraintB = `CON-B-${runId}`;

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      // 播种 RLS 保护表（owner 连接是 superuser，绕过 RLS；后续应用查询在 GUC 下执行）。
      // org_id 列是 varchar(255)（schema.ts orgId），按文本写入 org UUID 字符串。
      await owner.begin(async (tx) => {
        for (const [id, orgId] of [
          [constraintA, fixture!.orgA.id],
          [constraintB, fixture!.orgB.id],
        ] as const) {
          await tx.unsafe(
            `insert into public.ewoh_scheduling_constraint
               (constraint_id, plan_id, type, org_id, active, source)
             values ($1, $2, 'forbidden_zone', $3, true, 'manual')`,
            [id, planId, orgId],
          );
        }
      });

      handle = await startE2EApp(e2eConfig, fixture.orgA.id);
      baseUrl = handle.baseUrl;
      // 以应用角色（runtime URL）直连，验证 RLS 对非 bypass 角色的真实过滤。
      runtimeClient = postgres(e2eConfig.runtimeDatabaseUrl, {
        max: 2,
        idle_timeout: 30_000,
        connect_timeout: 10,
        prepare: false,
      });
    }, 60000);

    afterAll(async () => {
      if (runtimeClient) {
        await runtimeClient.end();
      }
      if (handle) {
        await handle.close();
      }
      if (owner) {
        if (fixture) {
          await cleanupE2EFixture(owner, fixture);
        }
        await owner.end();
      }
    });

    it('并发请求：org A / org B 各自只读到自己 org 的约束行', async () => {
      const authA = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(authA.status).toBe(201);
      const authB = await login(
        baseUrl,
        fixture!.dispatcherB.username,
        fixture!.dispatcherB.password,
      );
      expect(authB.status).toBe(201);

      const path = `/api/scheduler/plans/${encodeURIComponent(planId)}/constraints`;
      const [resA, resB] = await Promise.all([
        apiRequest<Array<{ id: string; orgId: string | null }>>(baseUrl, path, {
          headers: jsonHeaders(authA.body.accessToken),
        }),
        apiRequest<Array<{ id: string; orgId: string | null }>>(baseUrl, path, {
          headers: jsonHeaders(authB.body.accessToken),
        }),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const idsA = (resA.body ?? []).map((c) => c.id);
      const idsB = (resB.body ?? []).map((c) => c.id);

      // 各自看到自己的行；绝不看到对方 org 的行。
      expect(idsA).toContain(constraintA);
      expect(idsA).not.toContain(constraintB);
      expect(idsB).toContain(constraintB);
      expect(idsB).not.toContain(constraintA);

      expect(idsA.every((id) => id === constraintA)).toBe(true);
      expect(idsB.every((id) => id === constraintB)).toBe(true);
    });

    it('原始 SQL：set_config(app.current_org_id) 下 RLS 策略真实过滤行', async () => {
      const allIds = [constraintA, constraintB];
      await runtimeClient!.begin(async (tx) => {
        // org A GUC → 只返回 org A 行
        await tx.unsafe(`select set_config('app.current_org_id', $1, true)`, [
          fixture!.orgA.id,
        ]);
        const gucA = await tx.unsafe<Array<{ current_setting: string | null }>>(
          `select current_setting('app.current_org_id', true) as current_setting`,
        );
        expect(gucA[0].current_setting).toBe(fixture!.orgA.id);

        const rowsA = await tx.unsafe<Array<{ constraint_id: string }>>(
          `select constraint_id
           from public.ewoh_scheduling_constraint
           where constraint_id = any($1::text[])
           order by constraint_id`,
          [allIds],
        );
        expect(rowsA.map((r) => r.constraint_id).sort()).toEqual(
          [constraintA].sort(),
        );

        // org B GUC → 只返回 org B 行
        await tx.unsafe(`select set_config('app.current_org_id', $1, true)`, [
          fixture!.orgB.id,
        ]);
        const rowsB = await tx.unsafe<Array<{ constraint_id: string }>>(
          `select constraint_id
           from public.ewoh_scheduling_constraint
           where constraint_id = any($1::text[])
           order by constraint_id`,
          [allIds],
        );
        expect(rowsB.map((r) => r.constraint_id).sort()).toEqual(
          [constraintB].sort(),
        );

        // 未知 org GUC → 不返回 either tenant row：证明 RLS 确实在过滤。
        await tx.unsafe(`select set_config('app.current_org_id', $1, true)`, [
          '00000000-0000-0000-0000-000000000000',
        ]);
        const rowsNone = await tx.unsafe<Array<{ constraint_id: string }>>(
          `select constraint_id
           from public.ewoh_scheduling_constraint
           where constraint_id = any($1::text[])
           order by constraint_id`,
          [allIds],
        );
        expect(rowsNone.map((r) => r.constraint_id)).toEqual([]);
      });
    });
  });
}
