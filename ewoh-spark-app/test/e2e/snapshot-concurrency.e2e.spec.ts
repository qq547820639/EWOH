/**
 * World snapshot 版本分配并发 E2E（真实 PostgreSQL，T-CONCURRENCY 扩展）。
 *
 * 覆盖（真实 PG + 真实 NestJS，非 mock）：
 *   并发 N 次 buildSnapshot（同一 service 实例，共享 DB）：
 *     - 全部成功（原子计数器 + 有界重试语义下并发分配不失败）；
 *     - 返回的 snapshotVersion 全部互异；
 *     - 同一天内严格递增且无缺口（WS-YYYYMMDD-0001..000N）；
 *     - ewoh_world_state_snapshot 中恰好 N 行，无重复 snapshot_version。
 *
 * 运行前提：与 concurrency-real-pg.e2e.spec.ts 相同（真实 PG + standalone API）。
 * 无运行时 DB 时整包 SKIP（resolveE2EConfig() 返回 null，CI 中 DB 恒存在）。
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
import { WorldStateSnapshotService } from '../../server/modules/scheduler/world-state.service';
import type { OrgContext } from '../../server/modules/shared/org-context.interceptor';

const e2eConfig = resolveE2EConfig();

// 无运行时 DB → 整包 SKIP（带清晰原因）；CI 中 DB 恒存在，不会跳过。
const runDescribe = e2eConfig ? describe : describe.skip;

runDescribe(
  e2eConfig
    ? 'World snapshot 并发版本分配 E2E（真实 PostgreSQL）'
    : 'World snapshot 并发版本分配 E2E（SKIP：无运行时 PostgreSQL，需 EWOH_E2E_RUNTIME_DATABASE_URL）',
  () => {
    const N = 8;
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let svc: WorldStateSnapshotService;
    const ctx: OrgContext = {
      userId: 'e2e-snapshot-concurrency',
      primaryOrgId: '',
      accessibleOrgIds: [],
      isGlobalAdmin: false,
    };

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      // 干净基线：仅清本 run fixture org 的快照行。R2-APT-009：原全表 DELETE
      // （含 ewoh_snapshot_version_counter 全局按日计数器）会摧毁共享库其他
      // 租户的同日快照并使其版本序列重置（与既有行冲突）——计数器为全局资产
      // 不再删除，版本起点断言相应放宽为"连续无缺口"（见用例内注释）。
      try {
        const orgIds = [fixture.orgA.id, fixture.orgB.id];
        const postgres = (await import('postgres')).default;
        const runtime = postgres(e2eConfig!.runtimeDatabaseUrl, { max: 1 });
        await runtime.unsafe('DELETE FROM ewoh_world_state_snapshot WHERE org_id = ANY($1::text[])', [orgIds]);
        await runtime.end();
      } catch {
        // 清理失败不阻断
      }
      handle = await startE2EApp(e2eConfig!, fixture.orgA.id);
      svc = handle.app.get(WorldStateSnapshotService, { strict: false });
      ctx.primaryOrgId = fixture.orgA.id;
      ctx.accessibleOrgIds = [fixture.orgA.id];
    }, 60_000);

    afterAll(async () => {
      if (handle) await handle.close();
      if (owner) {
        if (fixture) await cleanupE2EFixture(owner, fixture);
        await owner.end();
      }
    });

    it(`并发 ${N} 次 buildSnapshot → 版本互异、同日严格递增无缺口、恰好 ${N} 行无重复`, async () => {
      const results = await Promise.allSettled(
        Array.from({ length: N }, () => svc.buildSnapshot(ctx)),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // 原子分配语义下并发应全部成功；个别失败时给出原因（不得静默通过）。
      expect(fulfilled.length).toBe(N);

      const versions = fulfilled.map(
        (r) =>
          (r as PromiseFulfilledResult<{ snapshotVersion: string }>).value
            .snapshotVersion,
      );
      // 全部互异。
      expect(new Set(versions).size).toBe(N);

      // 同一天前缀，严格递增且无缺口（WS-YYYYMMDD-0001..000N）。
      const dayPrefix = versions[0].slice(0, 'WS-YYYYMMDD'.length);
      for (const v of versions) {
        expect(v.startsWith(`${dayPrefix}-`)).toBe(true);
      }
      const seqs = versions
        .map((v) => Number(v.split('-').pop()))
        .sort((a, b) => a - b);
      // R2-APT-009：不再清全局版本计数器（会破坏共享库其他租户同日序列），
      // 起点随当日已分配序号；并发原子分配的不变量是"互异 + 严格连续无缺口"。
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => seqs[0] + i));

      // DB 事实：本 org 恰好 N 行且 snapshot_version 无重复（org 过滤，R2-APT-009）。
      const postgres = (await import('postgres')).default;
      const sql = postgres(e2eConfig!.runtimeDatabaseUrl, { max: 1 });
      try {
        const rows = await sql`
          SELECT snapshot_version FROM ewoh_world_state_snapshot
          WHERE org_id = ANY(${sql.array([fixture.orgA.id, fixture.orgB.id])}::text[])
            AND snapshot_version LIKE ${`${dayPrefix}-%`}`;
        expect(rows.length).toBe(N);
        expect(new Set(rows.map((r) => r.snapshot_version)).size).toBe(N);
        // 全表唯一性兜底断言（含历史行，防御唯一约束失效）。
        const dup = await sql`
          SELECT snapshot_version, count(*)::int AS n
          FROM ewoh_world_state_snapshot
          GROUP BY snapshot_version
          HAVING count(*) > 1`;
        expect(dup.length).toBe(0);
      } finally {
        await sql.end();
      }
    }, 60_000);
  },
);
