/**
 * 试点链行为基线：平台侧「重启」列（调度→审批→派工→执行→回执）。
 *
 * 现有测试的 A/B 层用内存假库，无法表达进程生命周期；C 层脚本连的是外部常驻后端，
 * 从不重启它。本用例用进程内真实 Nest + 真实 PostgreSQL，把「后端重启后在飞工作如何恢复」
 * 变成可重复测量的事实（覆盖矩阵里此前全空的一列）。
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
const INGEST_KEY = 'e2e-ingest-key';

(config ? describe : describe.skip)(
  '控制命令跨后端重启 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let adminToken: string;
    const runId = randomUUID().slice(0, 8);
    const deviceId = `AGV-RS-${runId}`;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });

    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        handle = undefined as unknown as E2EAppHandle;
        if (fixture) await cleanupE2EFixture(owner, fixture);
        fixture = undefined as unknown as E2EFixture;
      }
    });

    afterAll(async () => {
      await owner?.end();
    });

    /** 起一个进程内后端并完成登录（重启即 close + 重新 start，同库不同句柄）。 */
    async function boot() {
      fixture ??= await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const admin = await login(
        handle.baseUrl,
        fixture.globalAdminA.username,
        fixture.globalAdminA.password,
      );
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
      return handle.baseUrl;
    }

    function gatewayHeaders() {
      return {
        'content-type': 'application/json',
        'x-ingest-key': INGEST_KEY,
        'x-org-id': fixture.orgA.id,
      };
    }

    async function commandRow(commandId: string) {
      const rows = await owner`select status, sent_at, delivered_at, response_at
        from ewoh_control_command where command_id = ${commandId}`;
      return rows[0];
    }

    async function pollPending(baseUrl: string) {
      const res = await apiRequest<{ commands?: { commandId: string }[] }>(
        baseUrl,
        `/api/control/commands/pending?deviceId=${deviceId}&limit=50`,
        { headers: gatewayHeaders() },
      );
      expect(res.status).toBe(200);
      return res.body.commands ?? [];
    }

    it('R-01 已下发未投递的命令跨重启仍可投递，且执行事实只落一次', async () => {
      let baseUrl = await boot();
      const created = await apiRequest<{ id: string }>(
        baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId,
            commandKeys: ['start'],
            idempotencyKey: `rs-${runId}`,
          }),
        },
      );
      expect(created.status).toBe(201);
      const sent = await apiRequest<{
        attempts?: { attemptId: string; commandKey: string }[];
      }>(baseUrl, `/api/control/requests/${created.body.id}/commands`, {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ commandKey: 'start', payload: {} }),
      });
      expect(sent.status).toBe(201);
      const commandId = sent.body.attempts!.find(
        (a) => a.commandKey === 'start',
      )!.attemptId;

      // 关停 = 重启：内存态全部丢弃，只有 PostgreSQL 里的事实存活。
      await handle.close();
      handle = undefined as unknown as E2EAppHandle;
      baseUrl = await boot();

      const afterRestart = await pollPending(baseUrl);
      expect(afterRestart.map((c) => c.commandId)).toContain(commandId);
      const delivered = await commandRow(commandId);
      expect(String(delivered.status)).toBe('sent');
      expect(delivered.delivered_at).not.toBeNull(); // 本轮 poll 即投递确认

      const ack = await apiRequest(baseUrl, `/api/control/commands/${commandId}/ack`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ delivered: true }),
      });
      expect([200, 201]).toContain(ack.status);

      const receipt = await apiRequest(baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { reboot: true } }),
      });
      expect([200, 201]).toContain(receipt.status);

      // 二次重启：终态不得被再次投递，也不得被再次回执成第二次执行。
      await handle.close();
      handle = undefined as unknown as E2EAppHandle;
      baseUrl = await boot();

      expect(await pollPending(baseUrl)).toHaveLength(0);
      const duplicate = await apiRequest(baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { replay: true } }),
      });
      expect(duplicate.status).toBe(400);
      const receipts = await owner`select count(*)::int as n
        from ewoh_control_result where command_id = ${commandId} and result_type = 'command_receipt'`.values();
      expect(Number(receipts[0][0])).toBe(1);
      expect(String((await commandRow(commandId)).status)).toBe('executed');
    });

    it('R-02 等待带不被误杀：重启后 6 小时（< 24h 授权有效期）的未交付命令仍是 sent', async () => {
      const baseUrl = await boot();
      const created = await apiRequest<{ id: string }>(
        baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId: `${deviceId}-ZOMBIE`,
            commandKeys: ['start'],
            idempotencyKey: `rsz-${runId}`,
          }),
        },
      );
      const sent = await apiRequest<{
        attempts?: { attemptId: string; commandKey: string }[];
      }>(baseUrl, `/api/control/requests/${created.body.id}/commands`, {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ commandKey: 'start', payload: {} }),
      });
      const commandId = sent.body.attempts!.find(
        (a) => a.commandKey === 'start',
      )!.attemptId;

      // 回拨到远超投递 SLA，然后重启：重启既不会回收它，也没有任何作业改它的状态。
      await owner`update ewoh_control_command
        set sent_at = now() - interval '6 hours' where command_id = ${commandId}`;
      await handle.close();
      handle = undefined as unknown as E2EAppHandle;
      await boot();

      const row = await commandRow(commandId);
      // F-02 落地后本例的含义变了（原为"记录缺口"）：过期时限取授权有效期（24h），
      // 6 小时仍属"还在等"的带——巡检只能提醒，**不得**提前判死。
      // 与 B-03 的①同一道防线：收敛的边界两边各钉一枚，防止把过期做成激进回收。
      expect(String(row.status)).toBe('sent');
    });

    it('R-03 过期收敛跨重启成立、不重复，且重启后的迟到回执仍按事实登记', async () => {
      const baseUrl = await boot();
      const created = await apiRequest<{ id: string }>(
        baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId: `${deviceId}-EXPIRED`,
            commandKeys: ['start'],
            idempotencyKey: `rse-${runId}`,
          }),
        },
      );
      const sent = await apiRequest<{ attempts?: { attemptId: string; commandKey: string }[] }>(
        baseUrl,
        `/api/control/requests/${created.body.id}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: 'start', payload: {} }),
        },
      );
      const commandId = sent.body.attempts!.find((a) => a.commandKey === 'start')!.attemptId;
      const sweep = () => apiRequest<{ expired?: number }>(
        handle.baseUrl, '/api/control/delivery-backlog/sweep',
        { method: 'POST', headers: jsonHeaders(adminToken), body: JSON.stringify({}) },
      );

      // 回拨到授权有效期之外 → 巡检收敛为 expired
      await owner`update ewoh_control_command
        set sent_at = now() - interval '25 hours' where command_id = ${commandId}`;
      const first = await sweep();
      expect([200, 201]).toContain(first.status);
      expect(first.body.expired).toBe(1);
      expect(String((await commandRow(commandId)).status)).toBe('expired');

      // 重启一轮：终态必须存活，且没有第二个 writer 把它重复产出或改回在飞
      await handle.close();
      handle = undefined as unknown as E2EAppHandle;
      await boot();
      const second = await sweep();
      expect([200, 201]).toContain(second.status);
      expect(second.body.expired).toBe(0);
      expect(String((await commandRow(commandId)).status)).toBe('expired');

      // 重启后设备才回话：事实照记，终态不动（两条事实各自成立，谁也不覆盖谁）
      const late = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { after: 'restart-and-expiry' } }),
      });
      expect([200, 201]).toContain(late.status);
      const after = await commandRow(commandId);
      expect(String(after.status)).toBe('expired');
      const receiptCount = await owner`select count(*)::int as n
        from ewoh_control_result where command_id = ${commandId} and result_type = 'command_receipt'`;
      expect(receiptCount[0].n).toBe(1);
    });
  },
);
