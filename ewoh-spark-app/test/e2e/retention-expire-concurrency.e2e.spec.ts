/// <reference types="jest" />
/**
 * EXPIR-01 的真库并发复现（V285）：模拟告警批量过期与运维处置在同一行上抢写时，
 * 带来源态谓词的 UPDATE 必须在行锁等待之后按 READ COMMITTED 重判——被处置的那行不得被置为 expired。
 *
 * V284 的常驻单测只钉住语句形状（谓词在不在、计数取 RETURNING），钉不住这条数据库语义；
 * 本用例把语义变成可失败的断言：同权限第二会话在未提交事务里先把 ev-2 改成 'handled' 撑开行锁窗口，
 * 再启动过期步，用 pg_locks / pg_stat_activity 确证「窗口真撑开了、过期那条 UPDATE 真在排队」，
 * 然后放行。两条前提断言任一不成立就当场红，绝不把"没撞上"读成"守卫生效"。
 *
 * 覆盖边界：证的是「锁等待后重判」＋本入口那句谓词的形状；不证运维处置入口与巡检在真实部署里
 * 撞同一窗口的频次（那是运行期问题）。dashboard 的 handle 写侧要不要补来源态谓词是另一问（未拍板，不动）。
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
import { RetentionService } from '../../server/modules/simulator/retention.service';

const e2eConfig = resolveE2EConfig();

if (!e2eConfig) {
  describe.skip('EXPIR-01 真库并发（缺少 owner 连接串）', () => {
    it('requires an owner DATABASE_URL', () => {
      expect(e2eConfig).not.toBeNull();
    });
  });
} else {
  describe('EXPIR-01 过期写与并发处置在真锁上的胜负（真实 PG）', () => {
    const runId = randomUUID().slice(0, 8);
    const marker = `F17-EXPIR-${runId}`;
    const eventIds = [`evt-${runId}-1`, `evt-${runId}-2`];
    let owner: OwnerSql;
    let interferer: ReturnType<typeof postgres>;
    let fixture: E2EFixture;
    let rowIds: string[] = [];
    // 失败也要放行：未提交的干预事务与 retention 自己的连接池若不在此收掉，
    // 一次红会留下打不开的锁与不退出句柄（V285 反证 M2 实测 jest 卡到超时）。
    let releaseGate: (() => void) | undefined;
    let retentionService: RetentionService | undefined;
    let originalUrl: string | undefined;
    afterEach(async () => {
      releaseGate?.();
      releaseGate = undefined;
      await retentionService?.onModuleDestroy();
      retentionService = undefined;
      if (originalUrl === undefined) delete process.env.EWOH_DATABASE_URL;
      else process.env.EWOH_DATABASE_URL = originalUrl;
    });

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      interferer = postgres(e2eConfig.ownerDatabaseUrl, { max: 1, prepare: false });
      const stale = new Date(Date.now() - 5 * 3_600_000).toISOString();
      // ewoh_event.org_id 是 varchar(255)（不 cast），retention 的批量改写按 uuid 主键 id ⇒ 取 returning id
      const seeded = await owner`insert into public.ewoh_event
                                   (event_id, org_id, event_type, severity, status, source_type, title, created_at)
                                 values (${eventIds[0]}, ${fixture.orgA.id}, 'simulated_alert', 'warning',
                                         'open', 'simulated', ${marker}, ${stale}::timestamptz),
                                        (${eventIds[1]}, ${fixture.orgA.id}, 'simulated_alert', 'warning',
                                         'open', 'simulated', ${marker}, ${stale}::timestamptz)
                                 returning id`;
      rowIds = seeded.map((r: { id: string }) => r.id);
    });

    afterAll(async () => {
      await owner`delete from public.ewoh_event where event_id in (${eventIds[0]}, ${eventIds[1]})`;
      await cleanupE2EFixture(owner, fixture);
      await interferer?.end({ timeout: 5 });
      await owner?.end({ timeout: 5 });
    });

    const rowOf = async (id: string) => {
      const r = await owner`select status, handler_action from public.ewoh_event where id = ${id}::uuid`;
      return r[0];
    };

    it('EXPIR-01 被并发处置的那行在锁释放后仍保持 handled，且过期条数只算真正改写的行', async () => {
      originalUrl = process.env.EWOH_DATABASE_URL;
      // ① 干预会话在未提交事务里持住 ev-2 的行锁（postgres.js 的事务只有回调式 ⇒ 用 gate 撑窗，收尾先放行再 end）
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      const held = interferer.begin(async (tx) => {
        await tx`update public.ewoh_event
                   set status = 'handled', handler_action = ${`${marker}:handled`}
                 where id = ${rowIds[1]}::uuid`;
        await gate;
      });

      // 前提：先确证行锁真被别的服务话台持有，否则下面的"没覆盖"什么都不是证据
      const lockDeadline = Date.now() + 20_000;
      let lockHeld = false;
      while (Date.now() < lockDeadline && !lockHeld) {
        const r = await owner`select count(*)::int as n
                                from pg_locks l join pg_class c on c.oid = l.relation
                               where c.relname = 'ewoh_event'
                                 and l.mode = 'RowExclusiveLock' and l.granted
                                 and l.pid <> pg_backend_pid()`;
        lockHeld = Number(r[0]?.n ?? 0) > 0;
        if (!lockHeld) await new Promise((res) => setTimeout(res, 250));
      }
      expect(lockHeld).toBe(true);

      // ② 过期步跑起来：ev-1 直接改写，ev-2 排在干预会话的行锁后面
      process.env.EWOH_DATABASE_URL = e2eConfig.ownerDatabaseUrl;
      const service = new RetentionService();
      retentionService = service;
      const expire = (service as unknown as {
        expireStaleSimulatedEvents(now: number): Promise<void>;
      }).expireStaleSimulatedEvents(Date.now());

      // 前提：确证那条 UPDATE 真在等锁（"它跑得快没撞上"与"守卫挡住了"在这里必须分得开）
      const waitDeadline = Date.now() + 20_000;
      let sawLockWait = false;
      while (Date.now() < waitDeadline && !sawLockWait) {
        const r = await owner`select count(*)::int as n
                                from pg_stat_activity
                               where datname = current_database()
                                 and state = 'active' and wait_event_type = 'Lock'
                                 and pid <> pg_backend_pid()
                                 and query ilike '%update%ewoh_event%'`;
        sawLockWait = Number(r[0]?.n ?? 0) > 0;
        if (!sawLockWait) await new Promise((res) => setTimeout(res, 250));
      }

      releaseGate();
      await held;
      await expire;

      expect(sawLockWait).toBe(true);
      expect(await rowOf(rowIds[0])).toMatchObject({ status: 'expired' });
      expect(await rowOf(rowIds[1])).toMatchObject({
        status: 'handled', handler_action: `${marker}:handled`,
      });
    }, 120_000);
  });
}
