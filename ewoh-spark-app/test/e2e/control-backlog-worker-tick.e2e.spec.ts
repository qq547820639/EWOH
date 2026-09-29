/**
 * 投递积压**周期触发**路径（RECOV-01，V206 新立常驻位点）。
 *
 * 问一句别的 spec 没问过的话：命令下发后设备永远不回执时，**没有任何人调 sweep**，
 * 平台自己会不会把它收敛掉？生产里承担这件事的是 `ControlDeliveryBacklogWorkerService`
 * 的 setInterval（默认间隔 `CONTROL_BACKLOG_WORKER_INTERVAL_MS` 缺省 600_000ms＝10 分钟）。
 * 而链上现有两处负向稳定窗只有 10s（`dispatch-offline-heal` P-01、`execution-offline-stuck` X-01），
 * 巡检在那里 0 次 tick；`backlog-snapshot-failure-boundary` 又是**显式调 HTTP sweep** 才收敛的
 * ⇒ 结论是"到点自己巡检"这一半行为此前没有常驻位点。本文件把它补上，并且自带反证。
 *
 * 两支成对断言（缺一支就是没证到）：
 *  - WB-01 间隔 2s：不碰任何 sweep 接口，命令应在若干个 tick 内自行收敛为 `expired`
 *    （`COMMAND_EXPIRED` + `delivery_expired` 结果行 + 趋势快照 +1，规则记 `business_deadline`）；
 *  - WB-02 间隔 600s（＝生产默认，且与常驻用例的时间尺度同级）：同一前提下等同样的时长，
 *    命令必须**仍是** `sent`、结果行必须**没有**——否则 WB-01 的收敛就可能是别的机制代劳的。
 *  ⇒ 两支合起来才说明：推进来自 worker 的 tick，而按生产默认间隔，这条收敛在任何常驻用例的时长内都不会发生。
 *
 * 夹具口径沿用 `backlog-snapshot-failure-boundary`：命令要先满足入池条件 `sent_at < now() - SLA`
 * 才谈得上过期（只推 deadline 会得到一条空断言，那边第一版就踩过）。
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
/** 收敛确证的上限：也是"生产默认间隔跑不完"里那个"同样时长"的量。 */
const WAIT_MS = 40_000;

(config ? describe : describe.skip)(
  '投递积压 worker 的周期触发（没有人调 sweep，平台会不会自己收敛过期命令）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    const runId = randomUUID().slice(0, 8);
    const deviceId = `AGV-WT-${runId}`;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
    }, 180_000);

    afterAll(async () => {
      // worker 间隔是**进程级** env，而 jest 一个 worker 里多个 spec 文件共用同一 process：
      // 不清掉就会替后面所有文件决定巡检节奏（与 e2e-app 里那条 PgFaultGuard 生命周期同源）。
      delete process.env.CONTROL_BACKLOG_WORKER_INTERVAL_MS;
      delete process.env.CONTROL_BACKLOG_WORKER_DISABLED;
      expect(process.env.CONTROL_BACKLOG_WORKER_INTERVAL_MS).toBeUndefined();
      if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      await owner?.end();
    });

    async function bootWith(intervalMs: string) {
      process.env.CONTROL_BACKLOG_WORKER_INTERVAL_MS = intervalMs;
      const handle = await startE2EApp(config!, fixture.orgA.id);
      const admin = await login(handle.baseUrl, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(admin.status).toBe(201);
      return { handle, adminToken: admin.body.accessToken };
    }

    /** 产品路径造一条"已下发未回执"的命令，再把它推进积压扫描集与显式截止已过。 */
    async function plantExpiredInFlight(handle: E2EAppHandle, adminToken: string, tag: string) {
      const created = await apiRequest<{ id: string }>(
        handle.baseUrl, '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ deviceId, commandKeys: ['start'], idempotencyKey: `wt-${tag}-${runId}` }),
        },
      );
      expect(created.status).toBe(201);
      const requestId = created.body.id;
      const sent = await apiRequest<{ attempts: { attemptId: string; commandKey: string }[] }>(
        handle.baseUrl, `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: 'start', payload: {} }),
        },
      );
      expect(sent.status).toBe(201);
      const commandId = sent.body.attempts.find((a) => a.commandKey === 'start')!.attemptId;
      const agedSent = await owner`update public.ewoh_control_command
                                     set sent_at = now() - interval '2 hour'
                                   where command_id = ${commandId}
                                     returning command_id as "commandId"`;
      expect(agedSent.length).toBe(1);
      const aged = await owner`update public.ewoh_control_request
                                 set deadline = now() - interval '1 hour'
                               where request_id = ${requestId} or id::text = ${requestId}
                                 returning request_id as "requestId"`;
      expect(aged.length).toBe(1);
      const row = await commandRow(commandId);
      expect(String(row.status)).toBe('sent');
      return { requestId, commandId };
    }

    async function commandRow(commandId: string) {
      const rows = await owner`
        select status, error_code as "errorCode"
          from public.ewoh_control_command where command_id = ${commandId}`;
      return rows[0] as Record<string, unknown>;
    }

    type ExpiryRow = { resultType: string; resultCode: string; expiryRule: string };

    async function expiryRows(commandId: string): Promise<ExpiryRow[]> {
      const rows = await owner`
        select result_type as "resultType", result_code as "resultCode",
               (result_json #>> '{expiryRule}') as "expiryRule"
          from public.ewoh_control_result where command_id = ${commandId}`;
      return rows as unknown as ExpiryRow[];
    }

    async function snapshotCount() {
      const rows = await owner`select count(*)::int as n from public.ewoh_control_backlog_snapshot`;
      return Number((rows[0] as Record<string, unknown>).n);
    }

    it('WB-01 间隔 2s：不碰 sweep，命令应由 worker 的 tick 自行收敛为 expired', async () => {
      const { handle, adminToken } = await bootWith('2000');
      try {
        const { commandId } = await plantExpiredInFlight(handle, adminToken, 'WB01');
        const snapBefore = await snapshotCount();
        const deadline = Date.now() + WAIT_MS;
        let row: Record<string, unknown> = {};
        let results: Awaited<ReturnType<typeof expiryRows>> = [];
        let ticks = 0;
        // 确证式等待（真等待原语 + 终态检查都在循环体内）：分不清"还没到点"与"永远不会到点"的读法
        // 在这类断言里等于没断（V170 收敛轴口径）。
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          ticks += 1;
          row = await commandRow(commandId);
          results = await expiryRows(commandId);
          if (String(row.status) === 'expired' && results.length > 0) break;
        }
        const snapAfter = await snapshotCount();
        console.log(
          `[WB-01] 等待 ${ticks}s（interval=2000ms）命令=${JSON.stringify(row)} `
          + `结果行=${JSON.stringify(results)} 快照 ${snapBefore}→${snapAfter}`,
        );
        expect(String(row.status)).toBe('expired');
        expect(String(row.errorCode)).toBe('COMMAND_EXPIRED');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].resultType).toBe('delivery_expired');
        expect(results[0].resultCode).toBe('COMMAND_EXPIRED');
        expect(results[0].expiryRule).toBe('business_deadline');
        expect(snapAfter).toBeGreaterThan(snapBefore);
      } finally {
        await handle.close();
      }
    }, 180_000);

    it('WB-02 反证：间隔 600s（生产默认）时同样时长内不收敛 ⇒ WB-01 的推进确实来自 worker', async () => {
      const { handle, adminToken } = await bootWith('600000');
      try {
        const { commandId } = await plantExpiredInFlight(handle, adminToken, 'WB02');
        await new Promise((r) => setTimeout(r, WAIT_MS));
        const row = await commandRow(commandId);
        const results = await expiryRows(commandId);
        console.log(
          `[WB-02] 等 ${WAIT_MS / 1000}s（interval=600000ms＝生产默认）命令=${JSON.stringify(row)} 结果行数=${results.length}`,
        );
        expect(String(row.status)).toBe('sent');
        expect(results.length).toBe(0);
      } finally {
        await handle.close();
      }
    }, 180_000);
  },
);
