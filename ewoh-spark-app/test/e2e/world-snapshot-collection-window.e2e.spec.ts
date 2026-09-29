/**
 * 世界快照的「采集 ↔ 版本分配」窗口（V105 探针，PROJ-01 第③项）。
 *
 * 普查（V102）记了一句走读结论：`world_state_snapshot.snapshot_json.entityContentVersions`
 * 的采集在快照事务之外。代码形状核实为真——`buildSnapshot()` 先 `collectState(ctx)` 读表，
 * **之后**才进 `allocateAndPersistSnapshot` 的 `runInTransaction`（`world-state.service.ts:109` 与 `:148-173`）。
 * 但"形状如此"不等于"后果如此"：本例把窗口撑开（一条只 sleep 的 BEFORE INSERT 触发器），
 * 在撑开的窗口里提交一条世界事实变更，然后量三件事：
 *   WS-01 前提：无并发变更时，最新持久化快照的版本映射 == 实时只读构建的映射；
 *   WS-02 读数：窗口内提交的变更不被新快照收下 ⇒ 出现「版本号更新、内容与前一条相同、
 *              而世界已经移动」的快照（两处 task 版本与实时读取互不相等）；
 *   WS-03 自愈：撤掉窗口后再跑一次构建，最新持久化快照追平世界（同时反证 device_id
 *              这条变更**确实**被版本化机制跟踪，否则 WS-02 的"不等"无从谈起）。
 * 三条互为对照：WS-01/WS-03 的"相等"是量程证明——探针能响，WS-02 的"不等"才可归因于窗口。
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
  type SchedulerFixture,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';
import { buildGucSettings } from '../../server/modules/shared/org-context.interceptor';
import { WorldStateSnapshotService } from '../../server/modules/scheduler/world-state.service';
import { RequestDatabaseContext } from '../../server/database/request-database-context';

const config = resolveE2EConfig();
const TRIGGER = 'ewoh_e2e_ws_widen_snapshot_window';

(config ? describe : describe.skip)(
  '世界快照采集窗口探针（V105：版本号更新是否等于世界更新）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let dispatcherToken = '';
    const runId = randomUUID().slice(0, 8);
    let persistedBaseline = 0;
    let baseline: { version: string; at: string; taskVersion: number | undefined } =
      { version: '', at: '', taskVersion: undefined };

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const d = await login(handle.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password);
      expect(d.status).toBe(201);
      dispatcherToken = d.body.accessToken;
    }, 180_000);

    afterAll(async () => {
      if (owner) await owner.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_world_state_snapshot;`);
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    const org = () => fixture.orgA.id;

    /** 实时只读构建（产品自己的采集实现，不另写一套哈希）。 */
    async function liveVersions(): Promise<Record<string, number>> {
      const rdc = handle.app.get(RequestDatabaseContext);
      const svc = handle.app.get(WorldStateSnapshotService);
      const snap = await rdc.runInTransaction(
        buildGucSettings({ userId: 'system:ws-probe', primaryOrgId: org() }),
        () => svc.buildSnapshotReadOnly({ userId: 'system:ws-probe', primaryOrgId: org() } as never),
      );
      return (snap as { entityContentVersions?: Record<string, number> }).entityContentVersions ?? {};
    }

    /** 库里最新一条已持久化快照。 */
    async function persisted(): Promise<{ version: string; at: string; map: Record<string, number> }> {
      const rows = await owner`
        select snapshot_version as "snapshotVersion",
               created_at at time zone 'utc' as "createdAt",
               snapshot_json as "json"
          from public.ewoh_world_state_snapshot
         where org_id::text = ${org()}
         order by created_at desc limit 1`;
      const r = rows[0] as Record<string, unknown>;
      const json = (typeof r.json === 'string' ? JSON.parse(r.json as string) : r.json) as
        { entityContentVersions?: Record<string, number> };
      return {
        version: String(r.snapshotVersion),
        at: String(r.createdAt),
        map: json?.entityContentVersions ?? {},
      };
    }

    /**
     * 走产品自己的"构建并持久化"路径。整段包在事务里，和生产环境的请求形状一致
     * （`org-context.interceptor` 会把 handler 整个包住），所以窗口不是"两个事务之间"，
     * 而是**同一事务内两条语句之间**（READ COMMITTED 下每条语句看见最新的已提交数据）：
     * `collectState` 读表 → 分配版本号并 INSERT。中间睡着的触发器就是把这段拉长。
     */
    function buildPersisted(tag: string) {
      const rdc = handle.app.get(RequestDatabaseContext);
      const svc = handle.app.get(WorldStateSnapshotService);
      return rdc.runInTransaction(
        buildGucSettings({ userId: 'system:ws-build', primaryOrgId: org() }),
        () => svc.buildSnapshot({ userId: 'system:ws-build', primaryOrgId: org() } as never),
      ).then((snap) => {
        console.log(`[${tag}] 已持久化快照版本=${String((snap as { snapshotVersion?: string }).snapshotVersion)}`);
        return snap;
      });
    }

    const taskKey = () => `task:${resources.taskId}`;

    it('WS-01 前提：无并发变更时，最新持久化快照与实时构建的版本映射一致', async () => {
      await buildPersisted('WS-01');
      const [live, per] = [await liveVersions(), await persisted()];
      console.log(
        `[WS-01] 持久化=${per.version}（${per.at}）task 版本=${String(per.map[taskKey()])} `
        + `实时 task 版本=${String(live[taskKey()])}；映射规模 持久=${Object.keys(per.map).length} 实时=${Object.keys(live).length}`,
      );
      expect(live[taskKey()]).toBeDefined();
      expect(per.map[taskKey()]).toBe(live[taskKey()]);
      baseline = { version: per.version, at: per.at, taskVersion: per.map[taskKey()] };
      const cnt = await owner`select count(*)::int as n from public.ewoh_world_state_snapshot
                               where org_id::text = ${org()}`;
      persistedBaseline = Number((cnt[0] as Record<string, unknown>).n);
      expect(persistedBaseline).toBeGreaterThan(0);
    }, 180_000);

    it('WS-02 把「采集→分配」之间的窗口撑开，在窗口里提交世界变更：快照收下的是哪个世界', async () => {
      // 唯一变量：一条只 sleep 的 BEFORE INSERT 触发器（不改变任何数据，只把
      // 「读表 → 分配版本并落库」之间的那段等待拉长，让并发提交能落进去）。
      await owner.unsafe(`
        DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_world_state_snapshot;
        CREATE OR REPLACE FUNCTION public.ewoh_e2e_ws_sleep_fn() RETURNS trigger AS $$
        BEGIN PERFORM pg_catalog.pg_sleep(5); RETURN NEW; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON public.ewoh_world_state_snapshot
        FOR EACH ROW EXECUTE FUNCTION public.ewoh_e2e_ws_sleep_fn();
      `);
      const pending = buildPersisted('WS-02');
      const buildStart = new Date();
      await new Promise((r) => setTimeout(r, 2_000));   // 采集已完成、插入正在睡
      const changeAt = new Date();
      await owner.unsafe(
        'update public.ewoh_production_task set device_id = $1 where id = $2::uuid',
        [`ALT-DEVICE-${runId}`, resources.taskId],
      );
      await pending;
      const buildEnd = new Date();
      const [live, per] = [await liveVersions(), await persisted()];
      console.log(
        `[WS-02] 变更后提交于 ${changeAt.toISOString()}；最新持久化=${per.version}（${per.at}）`
        + ` 基线=${baseline.version}（${baseline.at}）`
        + ` 其 task 版本=${String(per.map[taskKey()])} 基线 task 版本=${String(baseline.taskVersion)}`
        + ` 实时 task 版本=${String(live[taskKey()])} `
        + `⇒ 落后=${per.map[taskKey()] !== live[taskKey()]}`,
      );
      // 前提：窗口内确实落了**新**快照（不是"什么都没发生"）。
      const cnt = await owner`select count(*)::int as n from public.ewoh_world_state_snapshot
                               where org_id::text = ${org()}`;
      const nowN = Number((cnt[0] as Record<string, unknown>).n);
      console.log(`[WS-02] 快照行数 ${persistedBaseline}→${nowN}（窗口内是否真的落了新快照）`);
      expect(nowN).toBeGreaterThan(persistedBaseline);
      expect(per.version).not.toBe(baseline.version);
      // 前提（"窗口"而不是"快照过期"）：变更提交在构建事务**仍开着**的时候落下的。
      // buildStart 取在发起之后，是实际开始时刻的保守下界。
      console.log(
        `[WS-02] 构建事务区间 ${buildStart.toISOString()} → ${buildEnd.toISOString()}`
        + `，变更提交于 ${changeAt.toISOString()}`,
      );
      expect(buildStart.getTime()).toBeLessThan(changeAt.getTime());
      expect(changeAt.getTime()).toBeLessThan(buildEnd.getTime());
      // 世界已经移动（同一段采集代码在窗口之后重读，得到不同的版本）。
      expect(live[taskKey()]).not.toBe(baseline.taskVersion);
      // 读数：新快照的**内容版本**与基线那条完全相同，却落后于实时世界。
      expect(per.map[taskKey()]).toBe(baseline.taskVersion);
      expect(per.map[taskKey()]).not.toBe(live[taskKey()]);
    }, 240_000);

    it('WS-03 自愈检查：撤掉窗口后再构建一次，最新持久化快照是否追平世界', async () => {
      await owner.unsafe(`
        DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_world_state_snapshot;
        DROP FUNCTION IF EXISTS public.ewoh_e2e_ws_sleep_fn();
      `);
      await buildPersisted('WS-03');
      const [live, per] = [await liveVersions(), await persisted()];
      const left = await owner`select count(*)::int as n from pg_trigger where tgname = ${TRIGGER}`;
      console.log(
        `[WS-03] 再构建后：持久化 task 版本=${String(per.map[taskKey()])} 实时=${String(live[taskKey()])} `
        + `⇒ 追平=${per.map[taskKey()] === live[taskKey()]}；残留触发器=${String((left[0] as Record<string, unknown>).n)}`,
      );
      expect(Number((left[0] as Record<string, unknown>).n)).toBe(0);
      // 量程的另一半：这条变更确实被版本化机制跟踪（否则"追平"是恒真）。
      expect(per.map[taskKey()]).toBe(live[taskKey()]);
      expect(per.map[taskKey()]).not.toBe(baseline.taskVersion);
    }, 240_000);
  },
);
