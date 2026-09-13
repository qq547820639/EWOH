/**
 * P1-6（§六）：双实例真实 PostgreSQL replan 幂等 E2E。
 *
 * 覆盖（真实 PG + 两个独立 NestJS app 实例，共享同一 runtime DB，非 mock）：
 *   D1. advisory lock 实际生效：外部会话持有 org 级 pg_advisory_xact_lock 时，
 *       两实例同 org 同 trigger 并发触发 → 双双被跨实例守卫抑制（suppressed，run=null），
 *       DB 无任何 run/trigger/plan 产生（证明锁确实拦截，而非依赖实例内存态）。
 *   D2. 双实例并发同 org 同 trigger → 恰好一个 replan run 被创建（另一实例被
 *       守卫抑制或 durable triggerKey/cooldown 去重），DB 仅 1 条 run + 1 条 trigger，
 *       无重复 active replan 行；获胜实例产出有效 plan。
 *
 * 运行前提：真实 PostgreSQL（EWOH_E2E_RUNTIME_DATABASE_URL 或 :3101 standalone API）。
 * 无运行时 DB → 整包 SKIP（resolveE2EConfig() 返回 null，CI 中 DB 恒存在）。
 */
import { randomUUID } from 'node:crypto';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';

const e2eConfig = resolveE2EConfig();

// 无运行时 DB → 整包 SKIP（带清晰原因）；CI 中 DB 恒存在，不会跳过。
const runDescribe = e2eConfig ? describe : describe.skip;

const runId = randomUUID().slice(0, 8);

interface EventsResponse {
  run: { runId: string } | null;
  plans: unknown[];
  debounced: boolean;
  cascaded: string[];
  suppressed?: boolean;
  blocked?: boolean;
  blockReason?: string;
}

runDescribe(
  e2eConfig
    ? 'Replan 双实例幂等 E2E（真实 PostgreSQL）'
    : 'Replan 双实例幂等 E2E（SKIP：无运行时 PostgreSQL，需 EWOH_E2E_RUNTIME_DATABASE_URL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handleA: E2EAppHandle;
    let handleB: E2EAppHandle;
    let baseUrlA = '';
    let baseUrlB = '';
    let tokenA = '';
    let tokenB = '';

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      // Each fixture owns fresh UUID orgs; no pre-cleanup is necessary.
      await seedSchedulerFixture(owner, fixture.orgA.id);
      handleA = await startE2EApp(e2eConfig!, fixture.orgA.id);
      baseUrlA = handleA.baseUrl;
      // 第二个独立 app 实例（同一 runtime DB、同一 org）。
      handleB = await startE2EApp(e2eConfig!, fixture.orgA.id);
      baseUrlB = handleB.baseUrl;
      const loginA = await login(baseUrlA, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(loginA.status).toBe(201);
      tokenA = loginA.body.accessToken;
      const loginB = await login(baseUrlB, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(loginB.status).toBe(201);
      tokenB = loginB.body.accessToken;
    }, 90_000);

    afterAll(async () => {
      if (handleB) await handleB.close();
      if (handleA) await handleA.close();
      if (owner) {
        if (fixture) await cleanupE2EFixture(owner, fixture);
        await owner.end();
      }
    });

    /**
     * D1：外部会话持有 org 级 advisory xact lock → 两实例同触发均被守卫抑制。
     * 确定性证明跨实例守卫确实经 PostgreSQL advisory lock 生效（与 ReplanCoordinator
     * 同一 key 计算：hashtext('<orgId>:replan_guard')）。
     */
    it('D1: 外部持锁时两实例同触发均被跨实例守卫抑制（无重复 replan）', async () => {
      const postgres = (await import('postgres')).default;
      const locker = postgres(e2eConfig!.runtimeDatabaseUrl, { max: 1 });
      const entityId = `DEV-D1-${runId}`;
      const body = JSON.stringify({ trigger: 'DEVICE_OFFLINE', entityId });
      const orgKey = `${fixture.orgA.id}:replan_guard`;
      try {
        await locker.begin(async (tx) => {
          // 在事务内持有 org 级 advisory xact lock（不提交/不释放）。
          await tx`SELECT pg_advisory_xact_lock(hashtext(${orgKey}))`;
          const [rA, rB] = await Promise.all([
            apiRequest<EventsResponse>(baseUrlA, '/api/scheduler/events', {
              method: 'POST',
              headers: jsonHeaders(tokenA),
              body,
            }),
            apiRequest<EventsResponse>(baseUrlB, '/api/scheduler/events', {
              method: 'POST',
              headers: jsonHeaders(tokenB),
              body,
            }),
          ]);
          // 守卫未获得 → 双双 suppressed（非 debounced/blocked），不创建 run。
          expect(rA.body.run).toBeNull();
          expect(rB.body.run).toBeNull();
          expect(rA.body.suppressed).toBe(true);
          expect(rB.body.suppressed).toBe(true);
          expect(rA.body.blocked).toBeFalsy();
          expect(rB.body.blocked).toBeFalsy();

          // DB 事实：无 run、无 trigger、无 plan（锁直接拦截，未进入 evaluate）。
          const triggers = await tx`
            SELECT count(*)::int AS n FROM ewoh_replan_trigger
            WHERE org_id = ${fixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE' AND entity_id = ${entityId}`;
          expect(triggers[0].n).toBe(0);
          const runs = await tx`
            SELECT count(*)::int AS n FROM ewoh_scheduling_run
            WHERE org_id = ${fixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE' AND trigger_entity_id = ${entityId}`;
          expect(runs[0].n).toBe(0);
        });
      } finally {
        await locker.end();
      }
    }, 90_000);

    /**
     * D2：双实例并发同 org 同 trigger → 恰好一个 replan（另一实例被守卫抑制或
     * durable triggerKey/cooldown 去重），DB 无重复 active replan 行。
     */
    it('D2: 双实例并发同触发 → 恰好一个 replan，无重复 active replan 行', async () => {
      const entityId = `DEV-D2-${runId}`;
      const body = JSON.stringify({ trigger: 'DEVICE_OFFLINE', entityId });
      const results = await Promise.allSettled([
        apiRequest<EventsResponse>(baseUrlA, '/api/scheduler/events', {
          method: 'POST',
          headers: jsonHeaders(tokenA),
          body,
        }),
        apiRequest<EventsResponse>(baseUrlB, '/api/scheduler/events', {
          method: 'POST',
          headers: jsonHeaders(tokenB),
          body,
        }),
      ]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ status: number; body: EventsResponse }> =>
          r.status === 'fulfilled',
      );
      // 至少一个实例成功触发（并发竞态下另一实例可能 500（唯一键）——合法，不伪装）。
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const winners = fulfilled.filter((r) => r.value.body.run != null);
      // 恰好一个实例真正创建了 run（advisory lock + durable 去重双保险）。
      expect(winners.length).toBe(1);
      expect(winners[0].value.body.plans.length).toBeGreaterThanOrEqual(1);
      // 另一实例未创建 run：被守卫抑制或 durable 去重（debounced）——均不得产生第二个 replan。
      const others = fulfilled.filter((r) => r.value.body.run == null);
      for (const o of others) {
        expect(o.value.body.blocked).toBeFalsy();
        expect(o.value.body.plans).toEqual([]);
      }

      // Use the configured owner for the audit query; the HTTP requests remain
      // scoped runtime requests, while an unscoped runtime read is correctly
      // filtered by RLS and would falsely report zero rows.
      const sql = owner;
      try {
        const runs = await sql`
          SELECT run_id, status FROM ewoh_scheduling_run
          WHERE org_id = ${fixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE' AND trigger_entity_id = ${entityId}`;
        expect(runs.length).toBe(1);
        expect(runs[0].status).toBe('succeeded');
        // 无重复 active replan：仅 1 条 trigger 记录（triggerKey 唯一约束）。
        const triggers = await sql`
          SELECT count(*)::int AS n FROM ewoh_replan_trigger
          WHERE org_id = ${fixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE' AND entity_id = ${entityId}`;
        expect(triggers[0].n).toBe(1);
        // Plans do not have a run_id/plan_ids column in the persisted schema;
        // the run's authoritative plan linkage is the plan_ids JSONB on the
        // run row itself.
        const runPlanIds = await sql`
          SELECT plan_ids FROM ewoh_scheduling_run WHERE run_id = ${runs[0].run_id}`;
        const plans = await sql`
          SELECT count(*)::int AS n
          FROM ewoh_schedule_plan
          WHERE plan_id = ANY(${(runPlanIds[0].plan_ids as string[])}::text[])`;
        expect(plans[0].n).toBeGreaterThanOrEqual(1);
      } finally {
        // owner is shared with fixture setup/cleanup and is closed in afterAll.
      }
    }, 90_000);
  },
);
