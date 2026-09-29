/**
 * 试点链行为基线：投递认领与执行回执的**并发窗口**（真实 Nest + 真实 PostgreSQL）。
 *
 * 用行锁把「poll 读到 sent → 别处提交 executed → poll 写投递事实」这个窗口做成确定性时序，
 * 而不是靠运气撞竞态：txA 先 `FOR UPDATE` 持锁，poll 的条件 UPDATE 必然阻塞在锁上，
 * txA 再把行改成 executed 并提交，poll 恢复时 CAS 一定落空。
 * 这段代码正是 F-01 之后被收敛进 `transitionCommand` 的三处调用点之一，
 * 因此本用例同时是那次模块化调整的并发验收。
 */
import postgres from 'postgres';
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
import {
  FAST_WINDOW,
  lockWindowNote,
  waitTupleLockQueued,
} from '../helpers/e2e-lock-window';

const config = resolveE2EConfig();
const INGEST_KEY = 'e2e-ingest-key';

(config ? describe : describe.skip)(
  '控制命令投递并发窗口 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let adminToken: string;
    const runId = randomUUID().slice(0, 8);
    const deviceId = `AGV-RACE-${runId}`;

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

    async function boot(): Promise<string> {
      fixture = await createE2EFixture(owner);
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

    async function createSentCommand(tag = 'main'): Promise<{ requestId: string; commandId: string }> {
      const created = await apiRequest<{ id: string }>(
        handle.baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId,
            commandKeys: ['start'],
            idempotencyKey: `race-${runId}-${tag}`,
          }),
        },
      );
      expect(created.status).toBe(201);
      const sent = await apiRequest<{
        attempts?: { attemptId: string; commandKey: string }[];
      }>(handle.baseUrl, `/api/control/requests/${created.body.id}/commands`, {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ commandKey: 'start', payload: {} }),
      });
      expect(sent.status).toBe(201);
      const requestId = created.body.id;
      const commandId = sent.body.attempts!.find((a) => a.commandKey === 'start')!.attemptId;
      return { requestId, commandId };
    }

    /** 撤销入口（人面 `POST /requests/:id/revoke?action=revoke`）。 */
    function revokeRequest(baseUrl: string, requestId: string) {
      return apiRequest<{ status?: string }>(
        baseUrl, `/api/control/requests/${requestId}/revoke?action=revoke`,
        { method: 'POST', headers: jsonHeaders(adminToken) },
      );
    }

    /** 回执面入口（人面 `POST /requests/:id/receipts`），D-04/D-05 共用。 */
    /** 两条命令都在飞行中（sent）的请求：撤销腿与回执腿的重叠用例共用同一份种子形状。 */
    async function twoCommandSentRequest(
      baseUrl: string, tag: string,
    ): Promise<{ requestId: string; start: string; stop: string }> {
      const req = await apiRequest<{ id: string }>(baseUrl, '/api/control/requests', {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({
          deviceId, commandKeys: ['start', 'stop'], idempotencyKey: `race-${runId}-${tag}`,
        }),
      });
      expect(req.status).toBe(201);
      const out: Record<string, string> = {};
      for (const key of ['start', 'stop']) {
        const sent = await apiRequest<{ attempts?: { attemptId: string; commandKey: string }[] }>(
          baseUrl, `/api/control/requests/${req.body.id}/commands`,
          {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({ commandKey: key, payload: {} }),
          },
        );
        expect(sent.status).toBe(201);
        out[key] = sent.body.attempts!.find((a) => a.commandKey === key)!.attemptId;
      }
      return { requestId: req.body.id, start: out.start, stop: out.stop };
    }

    /** 请求行与它名下命令行的当前事实（权威表对，重叠用例的判词都读这一处）。 */
    async function requestFacts(requestId: string) {
      const cmds = await owner`SELECT command_id, status FROM ewoh_control_command
        WHERE request_id = ${requestId}`;
      const [rq] = await owner`SELECT status FROM ewoh_control_request WHERE request_id = ${requestId}`;
      const byId = new Map<string, string>(cmds.map((c) => [
        String((c as Record<string, unknown>).commandId ?? (c as Record<string, unknown>).command_id),
        String((c as Record<string, unknown>).status ?? (c as Record<string, unknown>).Status),
      ]));
      const row = (rq ?? {}) as Record<string, unknown>;
      return { byId, requestStatus: String(row.status ?? row.Status) };
    }

    function postReceipt(baseUrl: string, requestId: string, token: string) {
      return apiRequest<{ status?: string; error?: { message?: string } | string }>(
        baseUrl,
        `/api/control/requests/${requestId}/receipts`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({ commandKey: 'start', result: 'executed', receipt: { by: 'e2e' } }),
        },
      );
    }


    /**
     * V67 实测结论（替换此前的"缺可注入同步接缝"判断——那条是探针谓词写错造成的假结论）：
     * 接缝本来就在产品里，就是**行锁本身**。poll 的扫描是不加锁的普通 SELECT（读 MVCC 快照，
     * 不排队），因此它一定带着"这行还是 sent"的旧判断走到投递 CAS；CAS 的 UPDATE 才是排队点，
     * 等锁释放后 PostgreSQL 在新版本上重判 WHERE（READ COMMITTED），谓词落空 → 0 行 → 未命中。
     * 于是这条用例是**机制判别型**的：三个分支各有可观测的判据。
     *  - 被行锁排队 + CAS 挡下：出现 tuple 等待锁、命令不在响应里、`delivered_at` 仍为 NULL、无 gateway_ack；
     *  - 没排队（被连接池/拦截器挡在前面）：tuple 等待锁不出现 → 本用例直接失败，不许悄悄放过；
     *  - CAS 没挡下：命令出现在响应里或 `delivered_at` 被写 → F-09 的窗口就是真缺陷。
     */
    it('D-01 已执行命令不会被迟到的 poll 投给网关，投递事实也不落（行锁构造真实窗口）', async () => {
      const baseUrl = await boot();
      const { commandId } = await createSentCommand();
      // 单连接显式事务：begin/commit 之间锁一直持有，让 poll 的条件 UPDATE 必然排队。
      // 用 owner 连接持锁，才能在同会话里查询到别的会话的锁状态。
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT command_id FROM ewoh_control_command WHERE command_id = '${commandId}' FOR UPDATE`,
        );
        // 前提断言：锁不到行就没有窗口（锁 0 行的 FOR UPDATE 不报错，会伪装成"没人排队"）。
        expect((locked as unknown[]).length).toBe(1);

        const pollPromise = apiRequest<{ commands?: { commandId: string }[] }>(
          baseUrl,
          `/api/control/commands/pending?deviceId=${deviceId}&limit=10`,
          { headers: gatewayHeaders() },
        );
        const window = await waitTupleLockQueued(holder, 'ewoh_control_command');
        // 功效断言：没构造出重叠，本例就没有意义——直接失败而不是"跳过即通过"。
        // 排队没发生 ⇒ 并发窗口被挡在 SQL 之前（连接池饥饿或拦截器短路），属新机制，需据实改结论。
        console.log(`[D-01] 行锁排队观测 waited=${window.waited} probes=${window.probes}(×25ms) waiters=${window.waiters}`);
        expect(window.waited).toBe(true);

        await holder.unsafe(
          `UPDATE ewoh_control_command SET status = 'executed', response_at = now() WHERE command_id = '${commandId}'`,
        );
        await holder.unsafe('COMMIT');

        const poll = await pollPromise;
        expect(poll.status).toBe(200);
        expect(
          (poll.body.commands ?? []).map((c) => c.commandId),
        ).not.toContain(commandId);

        const [row] = await owner`SELECT status, delivered_at, revoked_at
          FROM ewoh_control_command WHERE command_id = ${commandId}`;
        expect(String(row.status)).toBe('executed');
        // 认领 CAS 落空 → 这一轮不得写「已交付」事实，否则现场会同时看到
        // 「已交付给网关」与「已执行完成」两条互相矛盾的记录。
        expect(row.deliveredAt ?? row.delivered_at).toBeNull();
        expect(row.revokedAt ?? row.revoked_at).toBeNull();
        const acks = await owner`SELECT count(*)::int AS n FROM ewoh_control_result
          WHERE command_id = ${commandId} AND result_type = 'gateway_ack'`.values();
        expect(Number(acks[0][0])).toBe(0);
        // 证据行：重叠是怎么发生的、等了多久才被观测到（写入 chain-specs.log）
        console.log(
          `[D-01] 行锁排队被观测 probes=${window.probes}(×25ms) waiters=${window.waiters} `
            + `commandId=${commandId} 响应含该命令=${(poll.body.commands ?? [])
              .some((c) => c.commandId === commandId)} delivered_at=NULL status=executed gateway_ack=0`
            + ` ⇒ 机制=「poll 无锁扫描读到 sent → 投递 CAS 在行锁上排队 → 锁释放后重判谓词 0 命中 → 本轮不投」`,
        );
      } finally {
        await holder.end();
      }
    });

    it('D-02 交付事实由 CAS 唯一化：窗口内重复 poll 不重复改写 delivered_at', async () => {
      const baseUrl = await boot();
      const { commandId } = await createSentCommand();
      const poll = await apiRequest<{ commands?: { commandId: string }[] }>(
        baseUrl,
        `/api/control/commands/pending?deviceId=${deviceId}&limit=10`,
        { headers: gatewayHeaders() },
      );
      expect((poll.body.commands ?? []).map((c) => c.commandId)).toContain(commandId);
      const [afterPoll] = await owner`SELECT delivered_at FROM ewoh_control_command
        WHERE command_id = ${commandId}`;
      expect(afterPoll.deliveredAt ?? afterPoll.delivered_at).not.toBeNull();
      const before = String(afterPoll.deliveredAt ?? afterPoll.delivered_at);

      const second = await apiRequest(
        baseUrl,
        `/api/control/commands/pending?deviceId=${deviceId}&limit=10`,
        { headers: gatewayHeaders() },
      );
      expect(second.status).toBe(200);
      const after = await owner`SELECT delivered_at FROM ewoh_control_command
        WHERE command_id = ${commandId}`;
      // 同一 60s 窗口内第二次命中时 CAS 应落空：交付时刻不被改写，配额也不重复计。
      expect(String(after[0].deliveredAt ?? after[0].delivered_at)).toBe(before);
    });

    /**
     * D-01 的**反向对照**（判别性检查，V67）：同样持锁、同样让 poll 的 CAS 排队，但提交时**不改状态**。
     * 需要它是因为 D-01 单独看是双因的：「没投出去」既可能来自窗口内那次状态改写，
     * 也可能来自锁本身（例如整条请求被排在 SQL 之外、或超时后静默丢弃）。
     * 实测应照常投递并写下 `delivered_at` ⇒ 锁不拦投递，D-01 的拦截只能归因于 CAS 谓词落空。
     */
    it('D-03 对照：只持锁不改状态时同一条命令照常投递', async () => {
      const baseUrl = await boot();
      const { commandId } = await createSentCommand();
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT command_id FROM ewoh_control_command WHERE command_id = '${commandId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);

        const pollPromise = apiRequest<{ commands?: { commandId: string }[] }>(
          baseUrl,
          `/api/control/commands/pending?deviceId=${deviceId}&limit=10`,
          { headers: gatewayHeaders() },
        );
        const window = await waitTupleLockQueued(holder, 'ewoh_control_command');
        expect(window.waited).toBe(true);
        // 只释放锁：行仍是 sent，CAS 谓词应当命中。
        await holder.unsafe('COMMIT');

        const poll = await pollPromise;
        expect(poll.status).toBe(200);
        expect(
          (poll.body.commands ?? []).map((c) => c.commandId),
        ).toContain(commandId);
        const [row] = await owner`SELECT status, delivered_at
          FROM ewoh_control_command WHERE command_id = ${commandId}`;
        expect(String(row.status)).toBe('sent');
        expect(row.deliveredAt ?? row.delivered_at).not.toBeNull();
        console.log(
          `[D-03] 反向对照 probes=${window.probes}(×25ms) waiters=${window.waiters} `
            + '响应含该命令=true delivered_at 已写 status=sent ⇒ 行锁本身不拦投递，'
            + 'D-01 的"不投"归因于 CAS 谓词在锁释放后重判落空',
        );
      } finally {
        await holder.end();
      }
    });

    /**
     * D-04：**回执侧**的同一窗口（V72，补 §5.4 那条「回执持锁阻塞后是否随后推进」的未命中项）。
     *
     * 为什么这条不是 D-01 的重复：D-01 证的是**投递**侧（poll 无锁扫描 → 投递 CAS 排队 → 谓词重判落空）。
     * 回执侧虽然走同一个 `transitionCommand` CAS（`control.service.ts:929-949`，起始集合
     * `['sent','gateway_received']`），但它的**准入判断**在前：`getRequest` 是不加锁的普通读
     * （`:882`），"重复回执/请求已终态"这些拒绝都在那一刻按旧快照定完（`:889-913`）才去写。
     * 于是要害问题是：**锁释放后 CAS 重判落空时，那条已经按旧快照通过准入的回执会不会照样落事实**。
     * 既有 B-02 是**串行**测的（先 revoke 再回执），根本没有重叠窗口——与 V31→V67 对投递侧的关系一模一样。
     *
     * 观测形状与判据（三支都可翻）：
     *  ① 前提：`FOR UPDATE` 锁到 1 行；
     *  ② 功效：回执必须在行锁上**排过队**（`tuple` 等待锁出现）——这同时证明它已经越过旧快照准入、
     *     正卡在写入那一步；没排队就说明它在 SQL 之前被别的东西挡住了，本例结论作废；
     *  ③ 持锁者把行改成 `revoked` 后提交 ⇒ 回执必须 409 且理由是"状态已并发变为 revoked"，
     *     行**不得**被改写成 executed、`response_at` 不得被写、`command_receipt` 结果行必须为 0、
     *     请求聚合也不得被翻成 executed（否则就是"平台已撤回授权"这条事实被一条迟到回执抹掉）。
     * 持锁者那次 UPDATE 是**故障注入**（模拟并发转移），不是伪造业务事实：目的只在让行状态在窗口内变一次。
     */
    it('D-04 回执在行锁窗口内被并发撤回 ⇒ CAS 重判落空，迟到回执不得改写终态也不得落事实', async () => {
      const baseUrl = await boot();
      const { requestId, commandId } = await createSentCommand();
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT command_id FROM ewoh_control_command WHERE command_id = '${commandId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);

        const receiptPromise = postReceipt(baseUrl, requestId, adminToken);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_command');
        console.log(
          `[D-04] 回执侧行锁排队观测 waited=${window.waited} probes=${window.probes}(×25ms) `
            + `waiters=${window.waiters} commandId=${commandId} requestId=${requestId}`,
        );
        expect(window.waited).toBe(true);

        await holder.unsafe(
          // `chk_ewoh_control_command_revocation`（standalone_093）要求 revoked 必须带
          // revoked_reason——想"只翻状态"是写不进去的，这条注入因此顺带证实了库层的撤回约束。
          `UPDATE ewoh_control_command SET status = 'revoked', revoked_at = now(), `
          + `revoked_reason = 'authorization_revoked' WHERE command_id = '${commandId}'`,
        );
        await holder.unsafe('COMMIT');

        const receipt = await receiptPromise;
        const message = JSON.stringify(receipt.body ?? {}).slice(0, 240);
        const [row] = await owner`SELECT status, response_at, revoked_at
          FROM ewoh_control_command WHERE command_id = ${commandId}`;
        const facts = await owner`SELECT count(*)::int AS n FROM ewoh_control_result
          WHERE command_id = ${commandId} AND result_type = 'command_receipt'`;
        const [agg] = await owner`SELECT status FROM ewoh_control_request WHERE request_id = ${requestId}`;
        const cmdStatus = String(row.status ?? row.Status ?? '');
        console.log(
          `[D-04] 回执=${receipt.status} ${message} 命令行=${cmdStatus} `
            + `response_at=${row.responseAt ?? row.response_at ?? 'NULL'} `
            + `command_receipt 结果行=${Number(facts[0]?.n ?? facts[0]?.N ?? 0)} 请求聚合=${agg?.status ?? agg?.Status}`,
        );
        expect(receipt.status).toBe(409);
        expect(message).toContain('回执未被接受');
        expect(message).toContain('revoked');
        // 迟到回执不得抹掉"已撤回"这条事实，也不得留下任何执行痕迹。
        expect(String(row.status ?? row.Status)).toBe('revoked');
        expect(row.responseAt ?? row.response_at).toBeNull();
        expect(Number(facts[0]?.n ?? facts[0]?.N)).toBe(0);
        expect(String(agg?.status ?? agg?.Status)).not.toBe('executed');
      } finally {
        await holder.end();
      }
    });

    /**
     * D-05：D-04 的**两段对照**（缺任何一段，D-04 的 409 都是双因的）。
     *  a) 完全不持锁 ⇒ 回执必须正常落地（仪器可发性的底：这条链路在这个夹具下本来就通）；
     *  b) 同样持锁、同样让回执排队，但**不改状态** ⇒ 回执仍必须落地。
     * 于是 D-04 的拒绝只能归因于"窗口内那次并发撤回让 CAS 谓词落空"，而不是锁本身、
     * 也不是准入判断把它挡在 SQL 之前。
     */
    it('D-05 对照：不持锁 / 只持锁不改状态时，回执都照常落地（D-04 的归因）', async () => {
      const baseUrl = await boot();

      // (a) 无锁基线
      const plain = await createSentCommand('plain');
      const plainRes = await postReceipt(baseUrl, plain.requestId, adminToken);
      const [plainRow] = await owner`SELECT status FROM ewoh_control_command
        WHERE command_id = ${plain.commandId}`;
      const plainFacts = await owner`SELECT count(*)::int AS n FROM ewoh_control_result
        WHERE command_id = ${plain.commandId} AND result_type = 'command_receipt'`;
      console.log(
        `[D-5a] 无锁回执=${plainRes.status} 命令行=${plainRow?.status ?? plainRow?.Status} `
          + `结果行=${Number(plainFacts[0]?.n ?? plainFacts[0]?.N)}`,
      );
      expect(plainRes.status).toBe(201);
      expect(String(plainRow?.status ?? plainRow?.Status)).toBe('executed');
      expect(Number(plainFacts[0]?.n ?? plainFacts[0]?.N)).toBe(1);

      // (b) 持锁但不改状态
      const held = await createSentCommand('held');
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT command_id FROM ewoh_control_command WHERE command_id = '${held.commandId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);
        const receiptPromise = postReceipt(baseUrl, held.requestId, adminToken);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_command');
        console.log(`[D-5b] 行锁排队观测 waited=${window.waited} probes=${window.probes}(×25ms)`);
        expect(window.waited).toBe(true);
        await holder.unsafe('COMMIT');

        const res = await receiptPromise;
        const [row] = await owner`SELECT status, response_at FROM ewoh_control_command
          WHERE command_id = ${held.commandId}`;
        console.log(
          `[D-5b] 只持锁不改状态 → 回执=${res.status} 命令行=${row.status ?? row.Status} `
            + 'response_at 已写=' + `${(row.responseAt ?? row.response_at) != null}`,
        );
        expect(res.status).toBe(201);
        expect(String(row.status ?? row.Status)).toBe('executed');
        expect(row.responseAt ?? row.response_at).not.toBeNull();
      } finally {
        await holder.end();
      }
    });

    /**
     * D-06（RVAGG-01）：撤销与执行回执重叠时，**请求行**的状态不得取锁外的旧清单。
     *
     * `revoke()` 的三步是：①不带锁读整个请求（含命令清单）→ ②批量 CAS 把 in-flight 命令改成
     * `failed` → ③用①那份清单聚合成请求行状态。②的谓词由 PostgreSQL 在行锁后重判（命令行不会写错），
     * 但③算的是①那一刻的旧值：窗口内已被回执推到 `executed` 的那条命令，在③里被当成
     * "本次撤销改成的 failed"。后果有两面——请求行落成 `failed` 而命令行是 `executed`
     * （权威表对分叉、"失败/未执行/被撤回"三件事被塌成一件），且 NEST-424 那句
     * "partial_success 不可撤销"的前提检查用的也是同一份旧清单 ⇒ 本该被拒的撤销被放行。
     *
     * 应然（两条分支都必须成立，缺任何一条本例即红）：
     *  a) 若这次撤销被判为可以发生 ⇒ 请求行只能按**锁后真值**聚合成 `partial_success`；
     *  b) 若它被判为不该发生（NEST-424 同一句话）⇒ 必须 400，且撤销**之前**的三份事实原样存在。
     * 两条分支共同的底线：一条已被设备执行完的命令，绝不允许在请求行上被记成"失败"。
     *
     * (b) 对照臂（不持锁、无并发回执）：撤销必须照常成功——证明 a/b 的差别只来自那个窗口，
     * 而不是撤销这条路在本夹具下根本走不到。
     */
    it('RVAGG-01 撤销×回执重叠：请求行聚合不得用锁外旧清单（分叉即红），无重叠时撤销照常落地', async () => {
      const baseUrl = await boot();

      // —— 对照臂：无并发回执 ⇒ 撤销照常成功，请求行落 failed（本夹具这条路走得通）——
      const plainReq = await twoCommandSentRequest(baseUrl, 'rvagg-plain');
      const plainRes = await revokeRequest(baseUrl, plainReq.requestId);
      const plainFacts = await requestFacts(plainReq.requestId);
      console.log(
        `[RVAGG-01b] 无重叠：撤销=${plainRes.status} 请求行=${plainFacts.requestStatus} `
          + `两条命令=${plainFacts.byId.get(plainReq.start)}/${plainFacts.byId.get(plainReq.stop)}`,
      );
      expect(plainRes.status).toBe(201);   // Nest 的 POST 默认 201（撤销成功即返 2xx）
      expect(plainFacts.requestStatus).toBe('failed');
      expect(plainFacts.byId.get(plainReq.start)).toBe('failed');
      expect(plainFacts.byId.get(plainReq.stop)).toBe('failed');

      // —— 归因臂：同样持锁、同样让撤销的批量 CAS 排队，但**不改状态** ⇒ 撤销仍必须成功。
      //     缺这一臂，重叠臂那个 400 就可能是"锁等待本身让撤销失败"而不是"窗口内有并发事实"。——
      const heldReq = await twoCommandSentRequest(baseUrl, 'rvagg-held');
      const heldHolder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await heldHolder.unsafe('BEGIN');
        const heldLock = await heldHolder.unsafe(
          `SELECT command_id FROM ewoh_control_command WHERE command_id = '${heldReq.stop}' FOR UPDATE`,
        );
        expect((heldLock as unknown[]).length).toBe(1);
        const heldRevoke = revokeRequest(baseUrl, heldReq.requestId);
        const heldWindow = await waitTupleLockQueued(heldHolder, 'ewoh_control_command');
        console.log(
          `[RVAGG-01c] 只持锁不改状态：行锁排队观测 waited=${heldWindow.waited} probes=${heldWindow.probes}(×25ms)`,
        );
        expect(heldWindow.waited).toBe(true);
        await heldHolder.unsafe('COMMIT');
        const heldRes = await heldRevoke;
        const heldFacts = await requestFacts(heldReq.requestId);
        console.log(
          `[RVAGG-01c] 只持锁不改状态：撤销=${heldRes.status} 请求行=${heldFacts.requestStatus} `
            + `两条命令=${heldFacts.byId.get(heldReq.start)}/${heldFacts.byId.get(heldReq.stop)}`,
        );
        expect(heldRes.status).toBe(201);
        expect(heldFacts.requestStatus).toBe('failed');
        expect(heldFacts.byId.get(heldReq.start)).toBe('failed');
        expect(heldFacts.byId.get(heldReq.stop)).toBe('failed');
      } finally {
        await heldHolder.end();
      }

      // —— 重叠臂：撤销读了两条都 sent 的清单，回执在它的批量 CAS 排队期间把 stop 推到 executed ——
      const req = await twoCommandSentRequest(baseUrl, 'rvagg-race');
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT command_id FROM ewoh_control_command WHERE command_id = '${req.stop}' FOR UPDATE`,
        );
        // 前提断言：锁不到行就没有窗口（0 行的 FOR UPDATE 不报错，会伪装成"没人排队"）。
        expect((locked as unknown[]).length).toBe(1);

        const revokePromise = revokeRequest(baseUrl, req.requestId);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_command');
        console.log(
          `[RVAGG-01a] 行锁排队观测 waited=${window.waited} probes=${window.probes}(×25ms) waiters=${window.waiters}`,
        );
        // 功效断言：没构造出重叠，本例就没有意义——直接失败而不是"跳过即通过"。
        expect(window.waited).toBe(true);

        await holder.unsafe(
          `UPDATE ewoh_control_command SET status = 'executed', response_at = now() WHERE command_id = '${req.stop}'`,
        );
        await holder.unsafe('COMMIT');

        const res = await revokePromise;
        const facts = await requestFacts(req.requestId);
        console.log(
          `[RVAGG-01a] 窗口内撤销：响应=${res.status} 请求行=${facts.requestStatus} `
            + `start(本次撤销目标)=${facts.byId.get(req.start)} stop(窗口内已被回执推到 executed)=${facts.byId.get(req.stop)}`,
        );

        // 底线：命令行不被抹（回执那条必须还是 executed）
        expect(facts.byId.get(req.stop)).toBe('executed');
        // 两条分支二选一，且都不许出现"请求行=failed 而命令行有 executed"
        if (res.status === 201) {
          expect(facts.requestStatus).toBe('partial_success');
        } else {
          expect(res.status).toBe(400);
          expect(facts.requestStatus).toBe('pending_gateway');
          expect(facts.byId.get(req.start)).toBe('sent');
        }
      } finally {
        await holder.end();
      }
    });

    /**
     * D-07（RVAGG-02）：回执腿的请求行聚合也取在锁外读 ⇒ 可以让「两条命令都已 executed」
     * 与「请求行停在 `pending_gateway`」同时成立（聚合规则是全 executed ⇒ executed，被旧值覆盖就永远落不到终态）。
     *
     * 与上一臂同一个机制，只是把"对手那半事实"交给 holder 提交，时序因此是确定的：
     *  holder 锁住**请求行**（不改数据）→ 回执 A 读完清单（两条都 sent）、CAS 掉自己那条命令、
     *  接着堵在请求行的写（`ewoh_control_result` 的外键要拿父行 KEY SHARE，与 FOR UPDATE 相冲）；
     *  holder 再把另一条命令改成 executed 并提交 → A 恢复，用**自己那份旧清单**写请求行。
     *  ⇒ 末态：两条命令都 executed，请求行 pending_gateway。
     *
     * 两臂合起来才钉得住修法：
     *  a) 重叠臂＝命令全 executed ⇒ 请求行必须落到 executed（修前停在 pending_gateway ⇒ 红）；
     *  b) 归因臂＝同样持锁、同样让 A 排队，但 holder **不改那条命令** ⇒ 请求行停在 pending_gateway
     *     才是对的（那条命令确实还是 sent）——这一臂同时排除"锁本身让聚合出错"，也钉住修法不许过度收敛
     *     （不许把没执行的命令算成 executed）。
     */
    it('RVAGG-02 回执腿写请求行前必须重读命令真值：命令全 executed 而请求行停在 pending_gateway 即红', async () => {
      const baseUrl = await boot();
      const postCmd = (requestId: string, key: string) => apiRequest<{ status?: string }>(
        baseUrl, `/api/control/requests/${requestId}/receipts`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: key, result: 'executed', receipt: { by: 'e2e-rvagg02' } }),
        },
      );

      // —— a) 重叠臂 ——
      const req = await twoCommandSentRequest(baseUrl, 'rvagg02-race');
      let holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${req.requestId}' FOR UPDATE`,
        );
        // 前提断言：锁不到请求行就没有窗口（0 行的 FOR UPDATE 不报错，会伪装成"没人排队"）。
        expect((locked as unknown[]).length).toBe(1);

        const receipt = postCmd(req.requestId, 'start');
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        console.log(
          `[RVAGG-02a] 回执堵在请求行锁上 waited=${window.waited} probes=${window.probes}(×25ms) waiters=${window.waiters}`,
        );
        // 功效断言：A 已读完清单并停在请求行的写上，此时 holder 提交的那条命令改动必然在它之后。
        expect(window.waited).toBe(true);

        await holder.unsafe(
          `UPDATE ewoh_control_command SET status = 'executed', response_at = now()`
          + ` WHERE command_id = '${req.stop}'`,
        );
        await holder.unsafe('COMMIT');

        const res = await receipt;
        const facts = await requestFacts(req.requestId);
        console.log(
          `[RVAGG-02a] 重叠回执=${res.status} 请求行=${facts.requestStatus} `
            + `start(本笔回执)=${facts.byId.get(req.start)} stop(holder 提交的另一笔)=${facts.byId.get(req.stop)}`,
        );
        expect(res.status).toBe(201);
        expect(facts.byId.get(req.start)).toBe('executed');
        expect(facts.byId.get(req.stop)).toBe('executed');
        // 命令全 executed ⇒ 请求行必须落到 executed；停在 pending_gateway 就是被锁外清单覆盖掉的假终态。
        expect(facts.requestStatus).toBe('executed');
      } finally {
        await holder.end();
      }

      // —— b) 归因臂：同样持锁、同样排队，但不改那条命令 ⇒ pending_gateway 才是对的 ——
      const ctl = await twoCommandSentRequest(baseUrl, 'rvagg02-held');
      holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${ctl.requestId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);
        const receipt = postCmd(ctl.requestId, 'start');
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        expect(window.waited).toBe(true);
        await holder.unsafe('COMMIT');
        const res = await receipt;
        const facts = await requestFacts(ctl.requestId);
        console.log(
          `[RVAGG-02b] 只持锁不改命令：回执=${res.status} 请求行=${facts.requestStatus} `
            + `start=${facts.byId.get(ctl.start)} stop=${facts.byId.get(ctl.stop)}`,
        );
        expect(res.status).toBe(201);
        expect(facts.byId.get(ctl.start)).toBe('executed');
        expect(facts.byId.get(ctl.stop)).toBe('sent');
        expect(facts.requestStatus).toBe('pending_gateway');
      } finally {
        await holder.end();
      }
    });

    /**
     * RVAGG-03（V324 第五腿）：巡检的**请求行收敛写落空**不得被就地吞成一条日志。
     *
     * 读码定形的前提：`expireBacklogCommands` 与调用它的 `sweepDeliveryBacklog` 整条路都在
     * **一个请求事务**里（worker 经 runInTransaction，HTTP 路由经请求级事务拦截器），所以
     * 「命令行先提交、请求行后写」这个中间态对外不可见——本臂因此不测那一支。
     * 真正可达的是同一事务内的 `:1453 读请求行 → :1454 写请求行` 之间被并发方提交：
     * CAS 前值不等 ⇒ 0 行 ⇒ 抛 `STATE_CONFLICT` ⇒ 被 `:1460` 的 catch 就地降成 warn，
     * 循环继续、事务照常提交 ⇒ **命令行已 expired，请求行却停在别人写的那个态**，
     * 而命令已是终态、下一轮巡检不再扫到它 ⇒ 没有任何后续写者会补。
     */
    it('RVAGG-03 巡检收敛写落空不得被吞：命令行 expired 而请求行停在他人写的终态即红', async () => {
      const baseUrl = await boot();
      const sweep = () => apiRequest<{ expired?: number; expiryConflicts?: number }>(
        baseUrl, '/api/control/delivery-backlog/sweep',
        { method: 'POST', headers: jsonHeaders(adminToken), body: JSON.stringify({}) },
      );

      // —— a) 重叠臂：巡检堵在请求行锁上时，并发方把请求行改成另一个终态并提交 ——
      const req = await twoCommandSentRequest(baseUrl, 'rvagg03-race');
      const agedSent = await owner`UPDATE public.ewoh_control_command
                                     SET sent_at = now() - interval '2 hour'
                                   WHERE request_id = ${req.requestId} AND status = 'sent'
                                     RETURNING command_id AS "commandId"`;
      expect(agedSent.length).toBe(2);
      const agedReq = await owner`UPDATE public.ewoh_control_request
                                    SET deadline = now() - interval '1 hour'
                                  WHERE request_id = ${req.requestId}
                                    RETURNING request_id AS "requestId"`;
      expect(agedReq.length).toBe(1);
      const before = await requestFacts(req.requestId);
      // 前提断言：没有「命令在飞＋请求行是 pending_gateway」就没有窗口可谈（CAS 前值取的就是这一行的态）。
      expect(before.requestStatus).toBe('pending_gateway');
      expect(before.byId.get(req.start)).toBe('sent');

      let holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${req.requestId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);

        const sweepPromise = sweep();
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        console.log(
          `[RVAGG-03a] 巡检堵在请求行锁上 waited=${window.waited} probes=${window.probes}(×25ms) waiters=${window.waiters}`,
        );
        // 功效断言：巡检已走完命令收敛、停在请求行的写上，此时 holder 的改动必然落在它之后。
        expect(window.waited).toBe(true);

        // holder 只代表「并发方已把请求行写成另一个终态」这一件事；真实并发写者（回执腿）还会
        // 同时改命令行，而那一半被巡检自己的命令锁挡住，本臂不覆盖（限度见登记册）。
        await holder.unsafe(
          `UPDATE ewoh_control_request SET status = 'executed' WHERE request_id = '${req.requestId}'`,
        );
        await holder.unsafe('COMMIT');

        const res = await sweepPromise;
        const facts = await requestFacts(req.requestId);
        console.log(
          `[RVAGG-03a] 巡检=${res.status} 自报 expired=${res.body?.expired} `
            + `请求行=${facts.requestStatus} start=${facts.byId.get(req.start)} stop=${facts.byId.get(req.stop)}`,
        );
        expect(res.status).toBe(201);
        expect(facts.byId.get(req.start)).toBe('expired');
        expect(facts.byId.get(req.stop)).toBe('expired');
        // 聚合规则：任一命令 expired ⇒ 请求行必须是 timeout。停在 executed＝设备从未做过的终态。
        expect(facts.requestStatus).toBe('timeout');

        // 「会不会下一轮自己补上」——命令已终态、不再进扫描集 ⇒ 不会；这一句把瞬态与永久分开。
        const again = await sweep();
        const facts2 = await requestFacts(req.requestId);
        console.log(
          `[RVAGG-03a2] 二次巡检=${again.status} 自报 expired=${again.body?.expired} 请求行=${facts2.requestStatus}`,
        );
        expect(again.body?.expired ?? 0).toBe(0);
        expect(facts2.requestStatus).toBe('timeout');
      } finally {
        await holder.end();
      }

      // —— b) 归因臂：同样持锁、同样排队，但 holder 不改请求行 ⇒ 收敛照常落地 ——
      const ctl = await twoCommandSentRequest(baseUrl, 'rvagg03-held');
      await owner`UPDATE public.ewoh_control_command
                    SET sent_at = now() - interval '2 hour'
                  WHERE request_id = ${ctl.requestId} AND status = 'sent'`;
      await owner`UPDATE public.ewoh_control_request
                    SET deadline = now() - interval '1 hour'
                  WHERE request_id = ${ctl.requestId}`;
      holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${ctl.requestId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);
        const sweepPromise = sweep();
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        expect(window.waited).toBe(true);
        await holder.unsafe('COMMIT');
        const res = await sweepPromise;
        const facts = await requestFacts(ctl.requestId);
        console.log(
          `[RVAGG-03b] 只持锁不改请求行：巡检=${res.status} 自报 expired=${res.body?.expired} `
            + `请求行=${facts.requestStatus}`,
        );
        expect(res.status).toBe(201);
        expect(facts.byId.get(ctl.start)).toBe('expired');
        expect(facts.requestStatus).toBe('timeout');
      } finally {
        await holder.end();
      }
    });

    /**
     * RVAGG-04（V324 把同一族最后一处从"读码推断"做成实测）：sendCommand 的长窗口
     * （`:528` 无锁读请求行 → 插入新命令 → `:644` 按旧清单聚合写请求行）在并发方改掉请求行时
     * 必须**整笔不生效**，不许留下"命令发出去了、请求行却按旧清单算"。
     *
     * 它与巡检腿的差别在哪：两处都用同一次无锁读当 CAS 前值，但发令整条路都在**同一个请求事务**里，
     * 落空抛的 STATE_CONFLICT 会把它自己刚插入的那条命令行一并带回滚；巡检腿则把落空就地 catch
     * 成一条 warn（RVAGG-03 实测的那条）。所以本臂钉的不是"有没有守卫"，而是**回滚真的发生**——
     * 日后若有人把插入挪进独立事务（撤回腿 `revokeUndeliveredCommand` 为了"撤回比 409 活得久"
     * 就是这么改的），这条臂就会红。
     */
    it('RVAGG-04 发令腿并发改请求行时必须整笔回滚：留下新命令却按旧清单聚合即红', async () => {
      const baseUrl = await boot();

      /** 三键请求：start／stop 先在飞，pause 尚未发过 ⇒ 对 pause 的发令是合法的新尝试。 */
      async function threeKeyRequest(tag: string): Promise<string> {
        const created = await apiRequest<{ id: string }>(baseUrl, '/api/control/requests', {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId, commandKeys: ['start', 'stop', 'pause'], idempotencyKey: `race-${runId}-${tag}`,
          }),
        });
        expect(created.status).toBe(201);
        for (const key of ['start', 'stop']) {
          const sent = await apiRequest(
            baseUrl, `/api/control/requests/${created.body.id}/commands`,
            {
              method: 'POST',
              headers: jsonHeaders(adminToken),
              body: JSON.stringify({ commandKey: key, payload: {} }),
            },
          );
          expect(sent.status).toBe(201);
        }
        return created.body.id;
      }

      async function pauseCount(requestId: string): Promise<number> {
        const rows = await owner`SELECT command_id FROM public.ewoh_control_command
          WHERE request_id = ${requestId} AND command_key = 'pause'`;
        return rows.length;
      }

      const sendPause = (requestId: string) => apiRequest<{ error?: { message?: string } | string }>(
        baseUrl, `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: 'pause', payload: {} }),
        },
      );

      // —— a) 并发方改掉请求行 ⇒ 发令整笔不生效 ——
      const req = await threeKeyRequest('rvagg04-race');
      expect((await requestFacts(req)).requestStatus).toBe('pending_gateway');
      let holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${req}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);

        const send = sendPause(req);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        console.log(
          `[RVAGG-04a] 发令堵在请求行锁上 waited=${window.waited} probes=${window.probes}(×25ms) waiters=${window.waiters}`,
        );
        // 功效断言：发令已插好自己的命令行、停在请求行的写上——此刻 holder 的改动必然在它之前提交。
        expect(window.waited).toBe(true);

        await holder.unsafe(
          `UPDATE ewoh_control_request SET status = 'timeout' WHERE request_id = '${req}'`,
        );
        await holder.unsafe('COMMIT');

        const res = await send;
        const facts = await requestFacts(req);
        const paused = await pauseCount(req);
        console.log(
          `[RVAGG-04a] 发令=${res.status} 请求行=${facts.requestStatus} pause 命令行数=${paused} `
            + `命令行总数=${facts.byId.size}`,
        );
        expect(res.status).toBe(409);
        // 归因：必须是 CAS 落空那一条（别的前置守卫也会给 400/409，那就没有"窗口"可言）。
        expect(String(JSON.stringify(res.body ?? ''))).toContain('STATE_CONFLICT');
        // 假事实的形状＝"pause 发出去了、请求行却按 start/stop 的旧清单算"。这里两者都不许发生。
        expect(paused).toBe(0);
        expect(facts.requestStatus).toBe('timeout');
      } finally {
        await holder.end();
      }

      // —— b) 归因臂：同样持锁、同样排队，但不改请求行 ⇒ 发令照常落地、聚合按真值 ——
      const ctl = await threeKeyRequest('rvagg04-held');
      holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${ctl}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);
        const send = sendPause(ctl);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        expect(window.waited).toBe(true);
        await holder.unsafe('COMMIT');
        const res = await send;
        const facts = await requestFacts(ctl);
        const paused = await pauseCount(ctl);
        console.log(
          `[RVAGG-04b] 只持锁不改请求行：发令=${res.status} 请求行=${facts.requestStatus} pause 命令行数=${paused}`,
        );
        expect(res.status).toBe(201);
        expect(paused).toBe(1);
        expect(facts.byId.size).toBe(3); // byId 是 Map：Object.keys() 恒空，会把断言写成永远红
        expect(facts.requestStatus).toBe('pending_gateway');
      } finally {
        await holder.end();
      }
    });

    /**
     * RVAGG-05（V325 第六腿）：撤回腿（投递前复核不过 ⇒ `revokeUndeliveredCommandWrites`）把
     * 「命令行＋结果行＋审计＋提醒＋请求行收敛」写在**同一个独立事务**里（`runDetachedTransaction`，
     * 因为"撤回是安全决策，必须比返回 409 活得更久"），其中请求行那一步的 CAS 前值取自
     * 紧邻写之前的一次无锁 `getRequestOrNull`。
     *
     * 本臂要答的是"落空之后谁负责"：并发方在 `getRequestOrNull` 与 `updateRequestStatus` 之间提交 ⇒
     * 0 行命中 ⇒ 抛 `STATE_CONFLICT`。它没有被就地 catch（与巡检腿 RVAGG-03 不同），
     * 于是整笔独立事务回滚 ⇒ 命令行、结果行、请求行都不该留下半分。
     * 判词＝**"要么整笔发生、要么整笔不发生，且失败对调用方可见"**；
     * 若读到"命令 revoked 而请求行没跟上"或"poll 返回 2xx 而什么都没撤"，就是本行要钉的假事实。
     */
    it('RVAGG-05 撤回腿落空必须整笔回滚且可见：留下半分撤回或静默 2xx 即红', async () => {
      const baseUrl = await boot();
      const devA = `AGV-RACE-${runId}-05a`;
      const devB = `AGV-RACE-${runId}-05b`;

      async function oneSentCommandOn(device: string, tag: string) {
        const created = await apiRequest<{ id: string }>(baseUrl, '/api/control/requests', {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId: device, commandKeys: ['start'], idempotencyKey: `race-${runId}-${tag}`,
          }),
        });
        expect(created.status).toBe(201);
        const sent = await apiRequest<{ attempts?: { attemptId: string; commandKey: string }[] }>(
          baseUrl, `/api/control/requests/${created.body.id}/commands`,
          {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({ commandKey: 'start', payload: {} }),
          },
        );
        expect(sent.status).toBe(201);
        return {
          requestId: created.body.id,
          commandId: sent.body.attempts!.find((x) => x.commandKey === 'start')!.attemptId,
        };
      }

      const drain = (device: string) => apiRequest<{ commands?: unknown[]; revoked?: number }>(
        baseUrl, `/api/control/commands/pending?deviceId=${device}&limit=10`,
        { headers: gatewayHeaders() },
      );

      /** 撤回这条事实的"半分"证据：它落的 `delivery_rejected` 结果行（提醒与审计同在这笔独立事务里）。
       *  非恒真由 b 臂见证（同一份查询在只持锁那臂里必须 >0）——a 臂单独读到 0 不算证据。 */
      async function revokedFactRows(commandId: string): Promise<number> {
        const rows = await owner`SELECT result_id FROM public.ewoh_control_result
          WHERE command_id = ${commandId} AND result_type = 'delivery_rejected'`;
        return rows.length;
      }

      // —— a) 重叠臂：撤回腿堵在请求行锁上时，并发方把请求行写成另一个态并提交 ——
      const a = await oneSentCommandOn(devA, 'rvagg05-race');
      // 前提构造走 owner 直写：撤的是**授权来源**（请求行），撤回的**生产方**仍是被测代码（CC-01 同法）。
      await owner`UPDATE public.ewoh_control_request SET status = 'revoked' WHERE request_id = ${a.requestId}`;
      const pre = await requestFacts(a.requestId);
      expect(pre.byId.get(a.commandId)).toBe('sent');
      expect(pre.requestStatus).toBe('revoked');

      let holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${a.requestId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);

        const drainPromise = drain(devA);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        console.log(
          `[RVAGG-05a] 撤回腿堵在请求行锁上 waited=${window.waited} probes=${window.probes}(×25ms) waiters=${window.waiters}`,
        );
        expect(window.waited).toBe(true);

        await holder.unsafe(
          `UPDATE ewoh_control_request SET status = 'executed' WHERE request_id = '${a.requestId}'`,
        );
        await holder.unsafe('COMMIT');

        const res = await drainPromise;
        const facts = await requestFacts(a.requestId);
        const side = await revokedFactRows(a.commandId);
        console.log(
          `[RVAGG-05a] poll=${res.status} 自报 revoked=${res.body?.revoked ?? '-'} `
            + `请求行=${facts.requestStatus} 命令=${facts.byId.get(a.commandId)} delivery_rejected 结果行=${side}`,
        );
        // 落空 ⇒ 整笔独立事务回滚：命令行没被撤、事实行没落、请求行不被撤回腿写脏。
        expect(facts.byId.get(a.commandId)).toBe('sent');
        expect(side).toBe(0);
        expect(facts.requestStatus).toBe('executed');
        // 且这件事必须对调用方可见——静默 2xx 就是"撤了但没人知道"的第二种形状。
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        await holder.end();
      }

      // —— b) 归因臂：同样持锁、同样排队，但不改请求行 ⇒ 撤回整笔照常落地 ——
      const b = await oneSentCommandOn(devB, 'rvagg05-held');
      await owner`UPDATE public.ewoh_control_request SET status = 'revoked' WHERE request_id = ${b.requestId}`;
      holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${b.requestId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);
        const drainPromise = drain(devB);
        const window = await waitTupleLockQueued(holder, 'ewoh_control_request');
        expect(window.waited).toBe(true);
        await holder.unsafe('COMMIT');
        const res = await drainPromise;
        const facts = await requestFacts(b.requestId);
        const side = await revokedFactRows(b.commandId);
        console.log(
          `[RVAGG-05b] 只持锁不改请求行：poll=${res.status} 自报 revoked=${res.body?.revoked ?? '-'} `
            + `请求行=${facts.requestStatus} 命令=${facts.byId.get(b.commandId)} delivery_rejected 结果行=${side}`,
        );
        expect(res.status).toBe(200);
        expect(facts.byId.get(b.commandId)).toBe('revoked');
        expect(side).toBeGreaterThan(0);
        // 单条 revoked ⇒ 聚合就是 revoked：证明"落空"才是 a 臂回滚的成因，锁与排队本身不碍事。
        expect(facts.requestStatus).toBe('revoked');
      } finally {
        await holder.end();
      }
    });

    /**
     * RVAGG-06（V325 第二项）：真·双回执——两笔回执互以对方为窗口，**两个写者都是被测代码自己**。
     *
     * 为什么还要这一臂：RVAGG-02／03／05 的改动半边都由 holder 的裸 SQL 提交（那是"另一笔回执的写"的替身），
     * 所以它们证的是"请求行被他人覆盖"这一支；两笔真回执在锁→读→写下互相排队时会不会丢更新，
     * 之前只由代码形状推断、没实到过。
     * 真并发不可控时序 ⇒ 判据取**与顺序无关的不变量**（每轮末态必须等于聚合真值）。
     * 功效另测另报（见下面 overlapped 那段注释）：实测 6 轮里请求行的 tuple 锁排队 **0 次**
     * （池 `DB_POOL_MAX=20`，不是连接串号）。
     * **V326 更正这一句的解释**：0 次这个读数有效，但本行当时由它推的"这一支没有可测窗口"**不成立**——
     * 量不到是采样档的问题：每次 `pg_locks` 采样只是一个瞬间快照，四笔回执整批约 30 ms 完成，
     * 默认档 25 ms 常常只看得到一眼。V326 在同一个形状上各跑 16 轮：5 ms 档 16/16 观测到排队（峰值 1~3），
     * 25 ms 档 1/16 ⇒ 真窗口一直存在，于是补了下面那支常驻的 RVAGG-07（写者全是被测代码，另配变异反证）。
     * 本臂保留：它钉的仍是"两笔真回执并发时末态＝聚合真值"＋探针必须会开火，不再声称"这支无可测窗口"。
     */
    it('RVAGG-06 两笔真回执并发落账：每轮末态必须等于聚合真值，且排队探针必须会开火', async () => {
      const baseUrl = await boot();
      const postReceipt = (requestId: string, key: string, by: string) => apiRequest<{ status?: string }>(
        baseUrl, `/api/control/requests/${requestId}/receipts`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: key, result: 'executed', receipt: { by } }),
        },
      );

      const ROUNDS = 6;
      let overlapped = 0;
      for (let round = 1; round <= ROUNDS; round += 1) {
        const req = await twoCommandSentRequest(baseUrl, `rvagg06-${round}`);
        const pA = postReceipt(req.requestId, 'start', `e2e-06a-${round}`);
        const pB = postReceipt(req.requestId, 'stop', `e2e-06b-${round}`);
        const probe = await waitTupleLockQueued(owner, 'ewoh_control_request');
        const [rA, rB] = await Promise.all([pA, pB]);
        const facts = await requestFacts(req.requestId);
        if (probe.waited) overlapped += 1;
        console.log(
          `[RVAGG-06#${round}] A=${rA.status} B=${rB.status} 排队观测=${probe.waited}(probes=${probe.probes}) `
            + `start=${facts.byId.get(req.start)} stop=${facts.byId.get(req.stop)} 请求行=${facts.requestStatus}`,
        );
        expect([rA.status, rB.status]).toEqual([201, 201]);
        expect(facts.byId.get(req.start)).toBe('executed');
        expect(facts.byId.get(req.stop)).toBe('executed');
        // 两条命令都 executed ⇒ 请求行必须 executed；停在 pending_gateway 就是丢了一次更新。
        expect(facts.requestStatus).toBe('executed');
      }
      console.log(
        `[RVAGG-06] ${ROUNDS} 轮纯 HTTP 并发回执里，请求行 tuple 锁排队 ${overlapped} 轮`
        + '（0 轮不是本臂的判据——它只是"这一支没有可测窗口"的读数；探针是否活着由下面的正向对照负责）',
      );

      // 探针的正向对照（必须开火）：holder 锁住请求行、一笔真回执在飞 ⇒ 探针必须看到排队。
      // 有了这条，上面那句"6 轮 0 排队"才是测量而不是探针坏了。
      const ctl = await twoCommandSentRequest(baseUrl, 'rvagg06-probe-control');
      const ctlHolder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      try {
        await ctlHolder.unsafe('BEGIN');
        const locked = await ctlHolder.unsafe(
          `SELECT request_id FROM ewoh_control_request WHERE request_id = '${ctl.requestId}' FOR UPDATE`,
        );
        expect((locked as unknown[]).length).toBe(1);
        const inflight = postReceipt(ctl.requestId, 'start', 'e2e-06-ctl');
        const seen = await waitTupleLockQueued(owner, 'ewoh_control_request');
        console.log(
          `[RVAGG-06#ctl] holder 持锁时探针排队观测=${seen.waited} waiters=${seen.waiters} probes=${seen.probes}`,
        );
        expect(seen.waited).toBe(true);
        await ctlHolder.unsafe('COMMIT');
        expect((await inflight).status).toBe(201);
      } finally {
        await ctlHolder.end();
      }
    }, 180_000);

    /**
     * RVAGG-07（V326）：把 V325 记的「两笔真回执互相重叠那一支无可测窗口」**翻案**——窗口在，
     * 是上一轮的观测手段量不到。
     *
     * 形状：一条**锚点命令**（发出不回执）让请求行停在 pending_gateway，另三键反复「发令→回执」把
     * 请求做胖，末了四笔真回执 `Promise.all` 并发——**四个写者都是被测代码自己**，没有 holder 替身。
     * 为什么必须留锚点（本轮实测到的前提）：`aggregateControlStatus` 只看**已存在**的 attempt，
     * 没发过的键不算 pending ⇒ 已存在的 attempt 一全 executed，请求行就进 executed，
     * 而 `sendCommand` 在终端请求上一律 400（`control.service.ts:535-541`）⇒ 没有锚点堆不出胖请求。
     * 为什么胖请求有用：`receiveReceipt` 锁请求行之后的 `withFreshAttemptStatuses`（`:1034`→`:1035`，
     * SELECT 无 LIMIT）要重读该请求**全部**命令行，结果行/审计/事件也在同一笔事务里 ⇒ 行越多持锁段越长。
     * 观测档用 `FAST_WINDOW`（5 ms×400）：V326 在同一形状上各跑 16 轮，5 ms 档 16/16 看到 tuple 等待
     * （峰值 1~3），共用件默认档 25 ms 只有 1/16——每次采样只是一个瞬间的快照，
     * 回执整批约 30 ms 完成，25 ms 档常常只看得到一眼（取证 `tmp/v326-fine5ms.log`／`tmp/v326-coarse25ms.log`）。
     * 判据两根：①**功效**——至少一轮真观测到 tuple 等待，观测不到即红（这一支不许再靠推断过关）；
     * ②**安全**——每轮四笔回执都 201 且请求行必须 executed：四条最新命令都 executed 而请求行停在
     * pending_gateway，就是丢了一次更新（RVAGG-02 那族的假终态形状）。
     */
    it('RVAGG-07 四笔真回执并发：每轮末态必须等于聚合真值，且至少一轮真在请求行锁上排过队', async () => {
      const baseUrl = await boot();
      const device = `AGV-RACE-${runId}-07`;
      const RAMP_KEYS = ['stop', 'pause', 'return_to_dock'];
      const ALL_KEYS = ['start', ...RAMP_KEYS];
      const ROUNDS = 4;
      const RAMPS = 2;

      const sendCmd = (requestId: string, key: string) => apiRequest<{ message?: string }>(
        baseUrl, `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: key, payload: {} }),
        },
      );
      const postOneReceipt = (requestId: string, key: string, by: string) => apiRequest<{ status?: string }>(
        baseUrl, `/api/control/requests/${requestId}/receipts`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: key, result: 'executed', receipt: { by } }),
        },
      );
      async function commandRows(requestId: string): Promise<number> {
        const rows = await owner`SELECT count(*)::int AS n FROM public.ewoh_control_command
          WHERE request_id = ${requestId}`;
        return Number((rows[0] as Record<string, unknown>).n ?? 0);
      }

      let overlapped = 0;
      let peakWaiters = 0;
      for (let round = 1; round <= ROUNDS; round += 1) {
        const created = await apiRequest<{ id: string }>(baseUrl, '/api/control/requests', {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId: `${device}-r${round}`,
            commandKeys: ALL_KEYS,
            idempotencyKey: `race-${runId}-07-r${round}`,
          }),
        });
        expect(created.status).toBe(201);
        const requestId = created.body.id;

        // 锚点：一条挂在 sent 不回执，保证请求行在整段热身里都不终端。
        expect((await sendCmd(requestId, 'start')).status).toBe(201);
        for (let r = 0; r < RAMPS; r += 1) {
          for (const key of RAMP_KEYS) {
            expect((await sendCmd(requestId, key)).status).toBe(201);
            const rc = await postOneReceipt(requestId, key, `v326-ramp-${runId}-${round}-${r}-${key}`);
            expect(rc.status).toBe(201);
          }
        }
        const before = await requestFacts(requestId);
        // 前提：请求行还没进终端态（否则下面的发令会被终端门直接 400，就不是"胖请求上的并发回执"）
        expect(before.requestStatus).toBe('pending_gateway');
        for (const key of RAMP_KEYS) {
          expect((await sendCmd(requestId, key)).status).toBe(201);
        }

        const receiptPromise = Promise.all(
          ALL_KEYS.map((key) => postOneReceipt(requestId, key, `v326-m-${runId}-${round}-${key}`)),
        );
        const window = await waitTupleLockQueued(owner, 'ewoh_control_request', FAST_WINDOW);
        const results = await receiptPromise;
        const facts = await requestFacts(requestId);
        const rows = await commandRows(requestId);
        if (window.waited) overlapped += 1;
        peakWaiters = Math.max(peakWaiters, window.waiters);
        console.log(
          `[RVAGG-07#${round}] ${lockWindowNote(`07#${round}`, window, '', FAST_WINDOW.intervalMs)}`
          + ` 回执=${results.map((x) => x.status).join('/')}`
          + ` 请求行=${facts.requestStatus}`
          + ` 命令 executed 条数=${[...facts.byId.values()].filter((s) => s === 'executed').length}`
          + `/${facts.byId.size} 行数=${rows}`,
        );
        // 与顺序无关的安全判据
        expect(results.every((x) => x.status === 201)).toBe(true);
        expect(facts.requestStatus).toBe('executed');
      }
      console.log(
        `[RVAGG-07] ${ROUNDS} 轮「四个被测写者同时回执」里观测到请求行 tuple 锁排队 ${overlapped} 轮，`
        + `峰值 waiters=${peakWaiters}（采样档 ${FAST_WINDOW.intervalMs}ms×${FAST_WINDOW.probes}）`,
      );
      // 功效判据：一支都没排过队＝本臂什么都没测，必须红，不许把"没观测到"写成通过
      expect(overlapped).toBeGreaterThan(0);
    }, 240_000);
  },
);
