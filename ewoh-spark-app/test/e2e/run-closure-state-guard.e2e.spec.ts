/**
 * `closeSchedulingRun` 的真实库实测：它有 org 谓词、**没有来源态谓词** ⇒ 终态可被后到的写覆盖。
 *
 * 为什么值得单独立一个常驻用例（V156）：`ewoh_scheduling_run.status` 的唯一写入口是
 * `scheduling-run.lifecycle.ts#closeSchedulingRun`，V59 收口时把「两个所有者」并成一个并补上了 org 谓词，
 * 之后本试点（V79 的"与 closeSchedulingRun 同形"、V154 的"三个链内样本"）一直把它算进
 * "单一写者 + **CAS** + 0 行冲突"那一族。逐行读实现 + 读它自己的单测后这条不成立：
 * UPDATE 的 WHERE 只有 `(run_id, org_id)`，`set(input.patch)` 不带任何"当前态必须等于 X"的条件，
 * 所以它的"0 命中"只可能是**行不存在/租户不符**，永远不可能是并发冲突 ⇒ 它不是 CAS。
 * 现有单测钉的是"谓词里出现 run_id 与 org_id"（渲染 WHERE 文本），结构上看不见这件事；
 * 而 `markPlanDispatched` 那一侧的单测明确钉了"谓词必须同时含 plan_id 与 **status**"——同一个试点里两种强度。
 *
 * 本文件在真实 PostgreSQL 上把差异做成读数：
 * - RC-01/RC-02：第一次闭合命中；**终态之后再闭合仍然命中**，行被后到的写覆盖，且没有任何地方留下冲突信号
 *   （返回 true、logger 一声不响）⇒ 这是 RUN-02 的现状基线，钉的是"今天确实如此"，不主张这是正确语义。
 * - RC-03：org 谓词那一半仍然有效——换租户闭合 ⇒ false + 显式报错（含 stage 与 org）。
 * - RC-04：对照组（证明量具会区分）：`markPlanDispatched` 有来源态谓词 ⇒ 第二次同 `fromStatus` 直接 false。
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import {
  closeSchedulingRun,
  type RunClosureLogger,
} from '@server/modules/scheduler/scheduling-run.lifecycle';
import { markPlanDispatched } from '@server/modules/scheduler/scheduling-plan.lifecycle';

const config = resolveE2EConfig();
type ClosureDb = Parameters<typeof closeSchedulingRun>[0];

(config ? describe : describe.skip)(
  'scheduling_run 闭合入口的状态守卫实测（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let sql: ReturnType<typeof postgres>;
    let db: ClosureDb;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      // 运行角色（NOBYPASSRLS）+ 会话级租户 GUC：与产品请求上下文等价的隔离前提。
      sql = postgres(config!.runtimeDatabaseUrl, { max: 1 });
      await sql`select set_config('app.current_org_id', ${fixture.orgA.id}, false)`;
      // 与 server/database/standalone.provider.ts:326 同一构造（drizzle(client)）。
      db = drizzle(sql) as unknown as ClosureDb;
    });
    afterAll(async () => {
      try {
        if (sql) await sql.end({ timeout: 5 });
      } finally {
        if (fixture) await cleanupE2EFixture(owner, fixture);
        await owner?.end();
      }
    });

    const collector = () => {
      const errors: string[] = [];
      const logger: RunClosureLogger = {
        error: (message: string) => {
          errors.push(message);
          return undefined;
        },
      };
      return { errors, logger };
    };

    async function newRun(status = 'queued'): Promise<string> {
      const runId = `v156-run-${randomUUID()}`;
      await owner`INSERT INTO ewoh_scheduling_run (run_id, org_id, status)
                  VALUES (${runId}, ${fixture.orgA.id}, ${status})`;
      return runId;
    }

    async function readRun(runId: string) {
      const rows = (await owner`
        SELECT status, failure_reason FROM ewoh_scheduling_run WHERE run_id = ${runId}
      `) as Array<{ status: string; failure_reason: string | null }>;
      return rows[0];
    }

    it('RC-01 第一次闭合：命中 true、行进入终态、无报错', async () => {
      const runId = await newRun();
      const { errors, logger } = collector();
      const hit = await closeSchedulingRun(
        db,
        { runId, orgId: fixture.orgA.id, patch: { status: 'completed' }, stage: 'persisted' },
        logger,
      );
      expect(hit).toBe(true);
      expect(errors).toEqual([]);
      expect((await readRun(runId))?.status).toBe('completed');
    });

    it('RC-02 终态之后再闭合：仍然命中并覆盖终态，且不留任何冲突信号（RUN-02 现状基线）', async () => {
      const runId = await newRun();
      const first = collector();
      expect(
        await closeSchedulingRun(
          db,
          { runId, orgId: fixture.orgA.id, patch: { status: 'completed' }, stage: 'persisted' },
          first.logger,
        ),
      ).toBe(true);

      const second = collector();
      const again = await closeSchedulingRun(
        db,
        {
          runId,
          orgId: fixture.orgA.id,
          patch: { status: 'failed', failureReason: '后到的写（本用例注入）' },
          stage: 'failed',
        },
        second.logger,
      );
      // 现状：第二个写者收到"成功"，行从 completed 变成 failed，两处日志都没有"已被闭合"这件事。
      // 这条断言钉的是**已实测的现状**，不是主张它正确——修法（补来源态谓词/终态保护）归 RUN-02 裁决。
      expect(again).toBe(true);
      expect(second.errors).toEqual([]);
      const row = await readRun(runId);
      expect(row?.status).toBe('failed');
      expect(row?.failure_reason).toBe('后到的写（本用例注入）');
    });

    it('RC-03 org 谓词那一半仍然有效：换租户闭合 ⇒ false + 显式报错（含 stage 与 org）', async () => {
      const runId = await newRun();
      const { errors, logger } = collector();
      const hit = await closeSchedulingRun(
        db,
        {
          runId,
          orgId: fixture.orgB.id,
          patch: { status: 'completed' },
          stage: 'persisted',
        },
        logger,
      );
      expect(hit).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('闭合未命中');
      expect(errors[0]).toContain('stage=persisted');
      expect(errors[0]).toContain(fixture.orgB.id);
      // 行仍在原租户、仍是 queued：0 命中确实只是"没找到行"，不是状态守卫
      const rows = (await owner`SELECT status FROM ewoh_scheduling_run WHERE run_id = ${runId}`) as Array<{
        status: string;
      }>;
      expect(rows[0]?.status).toBe('queued');
    });

    it('RC-04 对照组：markPlanDispatched 带来源态谓词 ⇒ 第二次同 fromStatus 直接 false', async () => {
      const planId = `v156-plan-${randomUUID()}`;
      // 只填必要列（实测 `information_schema`：本表 NOT NULL 且无默认的列只有 plan_id/plan_name/strategy）
      // ——本用例要的是"有没有来源态谓词"，不是方案完整性。
      await owner`INSERT INTO ewoh_schedule_plan (plan_id, plan_name, strategy, org_id, status, version)
                  VALUES (${planId}, ${`V156 对照方案 ${planId}`}, 'scheduling_v2',
                          ${fixture.orgA.id}, 'approved', 1)`;
      const first = await markPlanDispatched(db, { planId, fromStatus: 'approved' });
      const second = await markPlanDispatched(db, { planId, fromStatus: 'approved' });
      const stale = await markPlanDispatched(db, { planId, fromStatus: 'approved' });
      expect([first, second, stale]).toEqual([true, false, false]);
      const rows = (await owner`SELECT status FROM ewoh_schedule_plan WHERE plan_id = ${planId}`) as Array<{
        status: string;
      }>;
      expect(rows[0]?.status).toBe('dispatched');
    });
  },
);
