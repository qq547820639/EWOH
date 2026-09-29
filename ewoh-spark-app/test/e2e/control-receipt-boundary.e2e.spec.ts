/**
 * 试点链（调度→审批→派工→执行→回执）行为基线：执行→回执阶段的命令终态边界。
 * 真实 NestJS + 真实 PostgreSQL（test/helpers/e2e-app 进程内启动，按 fixture 独立租户）。
 *
 * B-01 固化既有正确行为：已进入终态的命令不再被第二条回执改写。
 * B-02 复现 F-01（缺陷）：`revoked` 命令可被迟到/重放的回执直接改写为 `executed`，
 *     使「平台已撤回授权」这一事实从命令行消失。
 *
 * B-02 的前置态 `status='revoked'` 由 owner 直写。被测对象是 `receiveReceipt` 的
 * 状态转移守卫，不是撤回的生产方；撤回生产方另有 `test/e2e/control-actuator-loop.mjs`
 * 步骤 14/15 的真实路径覆盖（与本文件同法的 owner 直写用于构造篡改前提）。
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
/** 与 `startE2EApp` 内 legacy 无绑定 ingest key 保持一致（机面网关 fail-closed 的测试侧配置）。 */
const INGEST_KEY = 'e2e-ingest-key';

interface ControlCommandRow {
  command_id: string;
  status: string;
  revoked_at: Date | null;
  revoked_reason: string | null;
  response_at: Date | null;
}

(config ? describe : describe.skip)(
  '控制命令回执终态边界 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let adminToken: string;
    const runId = randomUUID().slice(0, 8);

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });

    beforeEach(async () => {
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const admin = await login(
        handle.baseUrl,
        fixture.globalAdminA.username,
        fixture.globalAdminA.password,
      );
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
    });

    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
    });

    afterAll(async () => {
      await owner?.end();
    });

    /** 建立一条低危命令：create → send，返回 requestId 与 commandId（台账 status=sent）。 */
    async function createSentCommand(
      tag: string,
    ): Promise<{ requestId: string; commandId: string }> {
      const created = await apiRequest<{ id: string; status: string }>(
        handle.baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId: `AGV-CHAIN-${tag}`,
            commandKeys: ['start'],
            idempotencyKey: `chain-${tag}`,
          }),
        },
      );
      expect(created.status).toBe(201);
      const requestId = created.body.id;

      const sent = await apiRequest<{
        attempts?: { attemptId: string; commandKey: string; status: string }[];
      }>(
        handle.baseUrl,
        `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: 'start', payload: {} }),
        },
      );
      expect(sent.status).toBe(201);
      const attempt = (sent.body.attempts ?? []).find(
        (item) => item.commandKey === 'start',
      );
      expect(attempt).toBeTruthy();
      return { requestId, commandId: attempt!.attemptId };
    }

    async function readCommand(commandId: string): Promise<ControlCommandRow> {
      const rows = await owner<ControlCommandRow[]>`
        select command_id, status, revoked_at, revoked_reason, response_at
        from ewoh_control_command where command_id = ${commandId}`;
      expect(rows).toHaveLength(1);
      return rows[0];
    }

    function gatewayHeaders() {
      return {
        'content-type': 'application/json',
        'x-ingest-key': INGEST_KEY,
        'x-org-id': fixture.orgA.id,
      };
    }

    it('B-01 已 executed 的命令重复回执被拒，且不改写已有回执事实', async () => {
      const { commandId } = await createSentCommand(`ok-${runId}`);

      const first = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { ack: 'first' } }),
      });
      expect([200, 201]).toContain(first.status);
      expect((await readCommand(commandId)).status).toBe('executed');

      const second = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'failed', receipt: { ack: 'second' } }),
      });
      expect(second.status).toBe(400);

      const after = await readCommand(commandId);
      expect(after.status).toBe('executed');
      const receipts = await owner`select count(*)::int as n
        from ewoh_control_result where command_id = ${commandId} and result_type = 'command_receipt'`;
      expect(receipts[0].n).toBe(1);
    });

    it('B-02 revoked 命令不得被迟到或重放的回执改写为 executed（F-01）', async () => {
      const { requestId, commandId } = await createSentCommand(`rev-${runId}`);

      await owner`
        update ewoh_control_command
        set status = 'revoked', revoked_at = now(), revoked_reason = 'authorization_revoked'
        where command_id = ${commandId}`;
      expect((await readCommand(commandId)).status).toBe('revoked');

      const receipt = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { ack: 'late' } }),
      });

      const after = await readCommand(commandId);
      // 契约（control.service.ts:2368-2373）：设备真的动过这条事实**必须**保留，
      // 但"执行了"与"被授权执行"是两件事——命令行不得被改写成一次正常执行。
      expect(after.status).toBe('revoked');
      expect(after.revoked_reason).toBe('authorization_revoked');
      expect(after.response_at).not.toBeNull();
      expect(receipt.status).toBeLessThan(400);

      const rows = await owner`select result_type from ewoh_control_result
        where command_id = ${commandId} order by result_id`.values();
      const resultTypes = rows.map(([value]) => String(value));
      // 既登记违规，也登记设备回执；两者都不以"正常执行"的口径进入命令状态。
      expect(resultTypes).toContain('authorization_violation');
      expect(resultTypes).toContain('command_receipt');

      const [requestRow] = await owner`select status from ewoh_control_request
        where request_id = ${requestId}`;
      expect(requestRow.status).not.toBe('executed');
    });
    it('B-03 F-02 收敛：积压带只提醒；超过授权有效期才收敛为 expired；迟到回执按事实登记不复活终态', async () => {
      const { requestId, commandId } = await createSentCommand(`sla-${runId}`);
      const sweepBacklog = () => apiRequest<{
        devicesWithBacklog?: number;
        created?: number;
        expired?: number;
        expiryConflicts?: number;
        expiryMs?: number;
      }>(handle.baseUrl, '/api/control/delivery-backlog/sweep', {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({}),
      });

      // ① 积压带（>SLA 5 分钟，<24h 授权有效期）：**只提醒，绝不提前终结命令**。
      //    这一条是防"为了收敛把还在等的命令一律判死"——过期与积压是两件事。
      await owner`
        update ewoh_control_command
        set sent_at = now() - interval '30 minutes'
        where command_id = ${commandId}`;
      const first = await sweepBacklog();
      expect([200, 201]).toContain(first.status);
      expect(first.body.expired).toBe(0);
      expect((first.body.devicesWithBacklog ?? 0)).toBeGreaterThanOrEqual(1);
      expect((await readCommand(commandId)).status).toBe('sent');

      // ② 过期带（>授权有效期）：CAS 收敛为 `expired` 终态 + 结果行 + 请求聚合到 `timeout`。
      //    （F-02 原基线：`AttemptStatus` 声明了 expired、聚合会产出 timeout，
      //     但链上没有任何生产者写出 expired —— 当时实测钉住的就是"仍停在 sent"。）
      await owner`
        update ewoh_control_command
        set sent_at = now() - interval '25 hours'
        where command_id = ${commandId}`;
      const second = await sweepBacklog();
      expect([200, 201]).toContain(second.status);
      expect(second.body.expired).toBe(1);
      expect(second.body.expiryConflicts).toBe(0);
      expect(second.body.expiryMs).toBeGreaterThan(0);
      expect((await readCommand(commandId)).status).toBe('expired');
      const expiryFacts = await owner`
        select count(*)::int as n from ewoh_control_result
        where command_id = ${commandId} and result_type = 'delivery_expired'`;
      expect(expiryFacts[0].n).toBe(1);
      const [requestRow] = await owner`
        select status from ewoh_control_request where request_id = ${requestId}`;
      // 只改命令行 = 悬挂从 attempt 挪到 request；聚合必须跟着落到终态
      expect(requestRow.status).toBe('timeout');

      // ③ 再巡检一轮：终态命令既不重复收敛，也不再算积压（收敛真的把悬挂摘掉了）
      const third = await sweepBacklog();
      expect([200, 201]).toContain(third.status);
      expect(third.body.expired).toBe(0);

      // ④ 迟到回执（机器面真实路径）：设备在平台放弃等待**之后**才回话。
      //    物理执行体"动了"这件事必须进台账；但平台不得因此把它当成一次正常执行。
      const late = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { ack: 'late-after-expiry' } }),
      });
      console.log('[B-03] 迟到回执响应=', late.status, JSON.stringify(late.body).slice(0, 400));
      expect([200, 201]).toContain(late.status);
      const afterLate = await readCommand(commandId);
      expect(afterLate.status).toBe('expired');
      expect(afterLate.response_at).toBeTruthy();
      const lateTypes = await owner`
        select result_type from ewoh_control_result where command_id = ${commandId}`;
      expect(lateTypes.map((r) => String(r.result_type))).toContain('command_receipt');
      const [requestAfterLate] = await owner`
        select status from ewoh_control_request where request_id = ${requestId}`;
      expect(requestAfterLate.status).toBe('timeout');

      // ⑤ 显式业务期限优先：`ewoh_control_request.deadline` 是契约里 business_deadline 那条边
      //    的载体（修复前它是一列没人读的死字段）。期限已过、下发才几分钟 → 也必须收敛，
      //    且结果行要写明是按哪条规则收敛的（两条规则的现场含义不同）。
      const dl = await createSentCommand(`deadline-${runId}`);
      // 采集口径仍是"下发超过投递 SLA"（未过 SLA 的命令本轮根本不进巡检视野——
      // 一条最短 5 分钟的宽限，避免刚下发的命令被就地判死）。
      await owner`
        update ewoh_control_command
        set sent_at = now() - interval '6 minutes'
        where command_id = ${dl.commandId}`;
      await owner`
        update ewoh_control_request
        set deadline = now() - interval '1 minute'
        where request_id = ${dl.requestId}`;
      const fifth = await sweepBacklog();
      expect([200, 201]).toContain(fifth.status);
      expect(fifth.body.expired).toBe(1);
      expect((await readCommand(dl.commandId)).status).toBe('expired');
      const rule = await owner`
        select result_json->>'expiryRule' as rule from ewoh_control_result
        where command_id = ${dl.commandId} and result_type = 'delivery_expired'`;
      expect(rule[0].rule).toBe('business_deadline');
    });
  },
);
