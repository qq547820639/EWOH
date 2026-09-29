/// <reference types="jest" />
/**
 * 派工 CAS 的租户谓词由哪一层承担（V82，F-06 剩余面的常驻回归位点）。
 *
 * 背景（实测，见基线文档 §5.4 F-06 / §七 V82）：`markPlanDispatched` 刻意**不**带 org 谓词，
 * 因为它两侧的历史写者都没有，而读面已有 `assertPlanTenantVisible`。当时的推断是
 * 「跨租户写在今天靠 RLS 兜着，而不是靠约束」——本用例把这句推断变成**可失败的断言**：
 * 用真实角色、真实策略跑产品自己的 CAS 形状。以下任一变化都会让它变红，而不是留下静默：
 *   - 运行时角色被授予 BYPASSRLS（或不再继承 policy 所属角色）；
 *   - `ewoh_schedule_plan` 被移出 RLS，或 service 角色在该表上的策略被删；
 *   - 全局管理员的跨租户分支被无意收紧/放宽（第 4 条把它钉成显式语义）。
 *
 * 断言都包在显式回滚的事务里：探针只观察命中数，不改变基线数据。
 *
 * 覆盖边界（不要夸大）：GUC 由产品自己的 `buildGucSettings` 生成，所以测的是**产品定义的**上下文形状；
 * 但本用例不验证"HTTP 请求运行时是否真的把这些变量设上了"——那一面归 D2 的
 * `EWOH_DB_REQUIRE_TX=1` 与走真实请求的链级用例（如 `plan-reject-authority` RJ-03）。
 */
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
import { buildGucSettings } from '../../server/modules/shared/org-context.interceptor';
import type { OrgContext } from '../../server/modules/shared/org-context.interceptor';

const e2eConfig = resolveE2EConfig();

if (!e2eConfig) {
  describe.skip('派工 CAS 的租户谓词归属（缺少运行角色连接串）', () => {
    it('requires a runtime DATABASE_URL', () => {
      expect(e2eConfig).not.toBeNull();
    });
  });
} else {
  describe('派工 CAS 的租户谓词归属（真实 PG + 真实角色 + 真实策略）', () => {
    const runId = randomUUID().slice(0, 8);
    const planId = `PLAN-V82-${runId}`;
    let owner: OwnerSql | undefined;
    let fixture: E2EFixture | undefined;
    let runtime: ReturnType<typeof postgres> | undefined;

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      await owner`insert into public.ewoh_schedule_plan
                    (plan_id, plan_name, strategy, org_id, status)
                  values (${planId}, 'V82 租户谓词探针', 'balanced',
                          ${fixture.orgA.id}::uuid, 'approved')`;
      runtime = postgres(e2eConfig.runtimeDatabaseUrl, {
        max: 2,
        idle_timeout: 30_000,
        connect_timeout: 10,
        prepare: false,
      });
    }, 60_000);

    afterAll(async () => {
      if (owner && fixture) {
        await cleanupE2EFixture(owner, fixture);
        await owner.end();
      }
      if (runtime) await runtime.end();
    });

    /** 与 markPlanDispatched 同形的 CAS；返回命中行数，且**总是回滚**。 */
    async function casUnder(actor: OrgContext | null, fromStatus: string): Promise<number> {
      const conn = await runtime!.reserve();
      try {
        await conn`begin`;
        for (const guc of actor ? buildGucSettings(actor) : []) {
          // 与产品一致：事务内 set_config（is_local=true）
          await conn.unsafe(`select set_config($1, $2, true)`, [guc.name, guc.value]);
        }
        const rows = await conn`
          with u as (
            update public.ewoh_schedule_plan set status = 'dispatched'
             where plan_id = ${planId} and status = ${fromStatus}
             returning 1)
          select count(*)::int as hit from u`;
        await conn`rollback`;
        return rows[0].hit;
      } finally {
        conn.release();
      }
    }

    async function statusOf(rowPlanId: string): Promise<string | null> {
      const rows = await owner`select status from public.ewoh_schedule_plan where plan_id = ${rowPlanId}`;
      return rows.length ? rows[0].status : null;
    }

    const actorOf = (orgId: string, isGlobalAdmin = false): OrgContext => ({
      userId: `v82-${runId}`,
      primaryOrgId: orgId,
      accessibleOrgIds: [orgId],
      isGlobalAdmin,
    });

    it('前提：运行时角色不绕 RLS，且该表确实在 RLS 之下（否则下面的 0 命中没有意义）', async () => {
      const attr = await owner`select r.rolname, r.rolbypassrls,
                pg_has_role('ewoh_api', 'service_role', 'member') as inherits_service
             from pg_roles r where r.rolname = 'ewoh_api'`;
      expect(attr).toHaveLength(1);
      expect(attr[0].rolbypassrls).toBe(false);
      expect(attr[0].inherits_service).toBe(true);

      const cls = await owner`select relrowsecurity from pg_class
                              where oid = 'public.ewoh_schedule_plan'::regclass`;
      expect(cls[0].relrowsecurity).toBe(true);

      const policies = await owner`select policyname from pg_policies
                                   where schemaname = 'public' and tablename = 'ewoh_schedule_plan'`;
      expect(policies.length).toBeGreaterThan(0);
    });

    it('本租户 actor：CAS 命中 1 行（探针能变绿，也证明形状不是永不命中）', async () => {
      await expect(casUnder(actorOf(fixture!.orgA.id), 'approved')).resolves.toBe(1);
    });

    it('错租户 actor：CAS 命中 0 行，且行状态未变（隔离由 DB 层谓词承担）', async () => {
      const hit = await casUnder(actorOf(fixture!.orgB.id), 'approved');
      expect(hit).toBe(0);
      expect(await statusOf(planId)).toBe('approved');
    });

    it('错租户 + isGlobalAdmin：命中 1 行 ⇒ 这是**有意保留**的跨租户分支，不是沉默漏洞', async () => {
      const hit = await casUnder(actorOf(fixture!.orgB.id, true), 'approved');
      expect(hit).toBe(1);
      // 之所以说"有意"：应用层的 assertTenantVisible 与 RLS 策略在这一支上语义一致（都放行）。
      // 若将来在应用层补一条 actor 派生的 org 谓词，这一支会被收紧成 0 —— 那是行为变更，需裁决。
      expect(await statusOf(planId)).toBe('approved');
    });

    it('无 GUC 的内部可信流：命中 0 行（缺上下文只会写空，不会跨租户）', async () => {
      const hit = await casUnder(null, 'approved');
      expect(hit).toBe(0);
      expect(await statusOf(planId)).toBe('approved');
    });

    it('功率对照：本租户 actor 但前置状态不匹配 ⇒ 命中 0（排除"0 命中只因形状不对"）', async () => {
      await expect(casUnder(actorOf(fixture!.orgA.id), 'confirmed')).resolves.toBe(0);
      await expect(casUnder(actorOf(fixture!.orgA.id), 'approved')).resolves.toBe(1);
    });

    it('所有探针事务都已回滚：基线行仍是播种时的 approved', async () => {
      expect(await statusOf(planId)).toBe('approved');
    });
  });
}
