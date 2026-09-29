/**
 * GUC 的"写侧归属"与"读侧可见"分工（V208）。
 *
 * 一问：**照抄仓内合规写法打开上下文的后台任务，读得到自己那一租户的行吗？只设一个 GUC 会怎样？**
 *
 * 为什么单独立一位点（V207 的教训推广）：WORKER-05 是"后台没上下文 ⇒ 静默读空"；V208 实测到同一族的
 * **前一半**——`ewoh_org_visible(org_id)`（多数 RLS 表的 SELECT/INSERT 策略都用它）只看
 * `app.current_org_ids`（逗号清单）与 `app.is_global_admin='true'`，而 `app.current_org_id`
 * **只被列 DEFAULT 用来归属写入**。于是"只设 org_id"这种看起来最自然的写法会：
 *   写得进（行归到该租户）＋ 读不到（同一会话 select 得 0 行）＋ 全程不报错。
 * 实测三臂（tmp/v208-probe2.log，基线库 ewoh_device，owner 视角该租户 266 行）：
 *   无 GUC=0 ｜ 只设 app.current_org_id=0 ｜ 只设 app.current_org_ids=266 ｜ is_global_admin='true'=266。
 * 本用例把这条差值钉成常驻断言，并把"策略正文确实读的是 org_ids/is_global_admin"写成前提
 * （前提与断言同层：哪天策略改写成读单列，红的是前提，不是结论被误读）。
 *
 * 覆盖边界（不要夸大）：这里测的是**库侧可见性规则与上下文形状的对应关系**，不测"某个 worker 有没有
 * 照抄这套写法"——那一面由 approval-expiry-worker-tick / control-backlog-worker-tick 的自发路径断言承担。
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
import { buildGucSettings, type OrgContext } from '../../server/modules/shared/org-context.interceptor';

const e2eConfig = resolveE2EConfig();

if (!e2eConfig) {
  describe.skip('GUC 读写侧分工（缺少运行角色连接串）', () => {
    it('requires a runtime DATABASE_URL', () => {
      expect(e2eConfig).not.toBeNull();
    });
  });
} else {
  describe('GUC 的写侧归属与读侧可见（后台上下文只设一个 GUC 会写得进、读不到）', () => {
    let owner: OwnerSql;
    let runtime: ReturnType<typeof postgres> | null = null;
    let fixture: E2EFixture;
    const runId = randomUUID().slice(0, 8);
    const deviceBusinessId = `GUC-SPLIT-${runId}`;
    const deviceRowId = randomUUID();

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      // 前提探针需要一行"归属明确"的行：用 owner 连接写（owner 绕过 RLS ⇒ 写入与上下文无关），
      // 可见性只由运行角色 + GUC 决定。afterAll 里删掉，不留残留。
      await owner.unsafe(
        `insert into public.ewoh_device
         (id, org_id, device_id, device_model, device_category, online, battery_pct, source_type,
          lifecycle_status, runtime_status, health_status, capabilities,
          last_telemetry_at, telemetry_updated_at)
         values ($1::uuid, $2::uuid, $3, 'GUC-SPLIT', 'exoskeleton', true, 95, 'simulated',
          'active', 'idle', 'normal', '[]'::jsonb, now(), now())`,
        [deviceRowId, fixture.orgA.id, deviceBusinessId],
      );
      runtime = postgres(e2eConfig!.runtimeDatabaseUrl, {
        max: 2,
        idle_timeout: 30_000,
        connect_timeout: 10,
        prepare: false,
      });
    }, 180_000);

    afterAll(async () => {
      if (owner) {
        // 必须用带标签的模板（参数化）：`unsafe` 把 ${} 原样拼进 SQL，uuid 字面量没引号 ⇒ 删除静默失败，
        // 于是这一行留在基线库里、后面的断言与连接池收尾一起塌。
        await owner`delete from public.ewoh_device where id = ${deviceRowId}::uuid`;
        const left = await owner`select count(*)::int as n from public.ewoh_device where id = ${deviceRowId}::uuid`;
        expect(left[0].n).toBe(0);
        await cleanupE2EFixture(owner, fixture);
        await owner.end();
      }
      if (runtime) await runtime.end();
    });

    /** 在给定 GUC 下数一次"本租户那台设备看得见吗"；总是回滚，不改任何行。 */
    async function visibleUnder(gucs: Array<{ name: string; value: string }>): Promise<number> {
      const conn = await runtime!.reserve();
      try {
        await conn`begin`;
        for (const guc of gucs) {
          await conn.unsafe(`select set_config($1, $2, true)`, [guc.name, guc.value]);
        }
        const rows = await conn`
          select count(*)::int as n from public.ewoh_device
           where device_id = ${deviceBusinessId}`;
        await conn`rollback`;
        return rows[0].n;
      } finally {
        conn.release();
      }
    }

    const actorOf = (orgId: string, isGlobalAdmin = false): OrgContext => ({
      userId: `v208-${runId}`,
      primaryOrgId: orgId,
      accessibleOrgIds: [orgId],
      isGlobalAdmin,
    });

    it('前提：这张表的策略正文读的确实是 app.current_org_ids / app.is_global_admin（不是单列 org_id）', async () => {
      const cls = await owner`select relrowsecurity from pg_class
                               where oid = 'public.ewoh_device'::regclass`;
      expect(cls[0].relrowsecurity).toBe(true);
      const pol = await owner`select qual, with_check from pg_policies
                               where schemaname = 'public' and tablename = 'ewoh_device'`;
      expect(pol.length).toBeGreaterThan(0);
      const text = pol.map((r: Record<string, string | null>) => `${r.qual} ${r.with_check}`).join(' ');
      expect(text).toContain('ewoh_org_visible');
      const fn = await owner`select pg_get_functiondef(p.oid) as def
                               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where p.proname = 'ewoh_org_visible' and n.nspname = 'public'`;
      // 该函数有重载（text／uuid 两个入参形态），逐条都断：任何一体重写成读单列，这条前提都会红
      const defs = (fn as unknown as Array<{ def: string }>).map((r) => String(r.def));
      expect(defs.length).toBeGreaterThanOrEqual(1);
      for (const def of defs) {
        expect(def).toContain('app.current_org_ids');
        expect(def).toContain('app.is_global_admin');
        // 反向对照：策略**不**读单列写侧 GUC ⇒ 上面"只设 org_id 读不到"才是机制结论而不是巧合
        expect(def).not.toMatch(/app\.current_org_id(?!s)/);
      }
    });

    it('GC-01 三臂对照：无 GUC 读不到／只设写侧 org_id 读不到／只设读侧 org_ids 读得到', async () => {
      const orgA = fixture!.orgA.id;
      const none = await visibleUnder([]);
      const writeOnly = await visibleUnder([{ name: 'app.current_org_id', value: orgA }]);
      const readSide = await visibleUnder([{ name: 'app.current_org_ids', value: orgA }]);
      console.log(
        `[GC-01] 无GUC=${none} 只设current_org_id=${writeOnly} 只设current_org_ids=${readSide}`,
      );
      expect(none).toBe(0);
      expect(writeOnly).toBe(0);
      expect(readSide).toBe(1);
    });

    it('GC-02 合规写法（照抄 buildGucSettings）读得到；把 org_ids 摘掉就读不到 ⇒ 位点会红', async () => {
      const orgA = fixture!.orgA.id;
      const settings = buildGucSettings(actorOf(orgA));
      const names = settings.map((s) => s.name);
      // 守卫的是"产品自己的上下文生成器同时给出读侧与写侧"：谁改成只留单列，这里先红
      expect(names).toContain('app.current_org_ids');
      expect(names).toContain('app.current_org_id');
      expect(await visibleUnder(settings)).toBe(1);

      const stripped = settings.filter((s) => s.name !== 'app.current_org_ids');
      expect(await visibleUnder(stripped)).toBe(0);
    });

    it('GC-03 全局管理员那一臂（systemGlobalAdminTransaction 的形状）读得到；换租户仍然读不到', async () => {
      const global = await visibleUnder([{ name: 'app.is_global_admin', value: 'true' }]);
      const other = await visibleUnder(
        buildGucSettings(actorOf(fixture!.orgB.id)),
      );
      console.log(`[GC-03] is_global_admin=true ⇒ ${global}｜orgB 合规上下文 ⇒ ${other}`);
      expect(global).toBe(1);
      expect(other).toBe(0);
    });
  });
}
