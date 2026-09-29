/**
 * 控制命令提醒的身份到底等不等？（V273：NOTIFICATION_FANOUT 格的 CTRL 族零时钟两桶）
 *
 * 问法：`ewoh_notification` 里 `NTF-CTRL-…` 这批行是**派生投影**（由命令行主事实 + 桶规则 +
 * 收件人规则 + 渠道开关算出）。口径此前只写在 `control.service.ts` 的两个调用点里，
 * 所以"改了收件人清单或桶名会不会红"在真实库上没有落点。本轮把口径提进
 * `contracts/state-machines/control.yaml` 的 `control_notification_identity`，本文件
 * **从契约自己拼期望集合**（前缀形状、收件人、渠道 enabled_when、截断长度都取自该块），
 * 再与落库行做**集合相等**比较，并同时核 external_ref 与 severity。
 *
 * 既有覆盖到底钉到哪一层（按断言语义搜过，不是按登记位点查）：
 *  - `test/e2e/control-actuator-loop.mjs:783-802` 真实库查提醒行，但**只查 backlog 两桶**
 *    （那两桶挂在 ageMs vs SLA 上，事后不可重算 ⇒ 不进本文件的等式，契约里列在 not_recomputable）；
 *  - `server/modules/control/control.service.spec.ts:702-713／1452-1470` 断过这两桶的 id，
 *    但用的是 `makeControlDb` 假 db ⇒ "被唯一键静默吞掉"这一后果在 mock 里结构上不可表示；
 *  - `test/e2e/control-receipt-boundary.e2e.spec.ts` 真实走到 `unauthorized_execution` 那条写，
 *    却从不读 `ewoh_notification`。
 *  ⇒ 零时钟两桶的**提醒身份**此前没有任何真实库位点，本文件补这一格（B-02 那条钉的是命令终态，不是提醒）。
 *
 * 五支断言：
 *  - CC-01 前提：授权在投递前被撤（`ewoh_control_request.status='revoked'`）后，
 *          `GET /api/control/commands/pending` 那条 drain **确实**把命令收成 revoked 且带原因码
 *          （前提不成立 ⇒ 后面几支没有可读的对象；这一支先钉住"事实真的发生了"）；
 *  - CC-02 delivery_revoked 等式：落库行集合 ＝ 契约重算集合（逐项 id、条数、external_ref、severity）；
 *  - CC-03 unauthorized_execution 等式：撤回后设备仍执行（迟到回执）⇒ 该桶集合相等，
 *          且主事实那一侧同时有 `authorization_violation` 结果行（两算：投影侧与权威侧都要在）；
 *  - CC-04 幂等：同一事实再触发一次（再 drain／再发一条重复回执）⇒ 行数与 id 集合**一字不动**
 *          （唯一键 + ON CONFLICT DO NOTHING 的可见后果：不是多一行，也不是报错）；
 *  - CC-05 无幽灵：一条正常投递、未被撤回、无违规回执的命令 ⇒ 它的前缀下必须 0 行
 *          （缺这一支，"两边都有行"可以恒真）。
 *
 * 限度（引用这一格之前要一起说）：等式覆盖的是**零时钟两桶**。backlog 两桶的桶名与收件人随
 * `ageMs vs escalationMultiplier×slaMs` 变（升级时加发 production_manager），事后重算会翻档 ⇒
 * 不在本文件；提醒正文（原因码中文标签等）也不进等式，只核 id 集合与 severity 列。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
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
const CONTRACT_PATH = resolve(__dirname, '../../../contracts/state-machines/control.yaml');
/** 与 `startE2EApp` 内 legacy 无绑定 ingest key 保持一致（机面网关 fail-closed 的测试侧配置）。 */
const INGEST_KEY = 'e2e-ingest-key';

interface IdentityContract {
  projection_table: string;
  authority_table: string;
  prefix_shape: string;
  id_shape: string;
  id_slice_chars: number;
  external_ref: string;
  buckets: Record<string, { recipients: Array<{ type: string; id: string }>; severity: string }>;
  channels: Array<{ name: string; enabled_when: string }>;
}

function identity(): IdentityContract {
  const doc = load(readFileSync(CONTRACT_PATH, 'utf8')) as {
    control_notification_identity?: IdentityContract;
  };
  const c = doc.control_notification_identity;
  if (!c || !c.prefix_shape || !c.id_shape || !c.buckets?.delivery_revoked
    || !c.buckets?.unauthorized_execution || !Array.isArray(c.channels)) {
    throw new Error('[CC] 契约 control.yaml 里读不到 control_notification_identity ⇒ 期望集合无从重算（判不可用=抛，不静默跳过）');
  }
  return c;
}

/** 渠道启用：逐条按契约写的 env 谓词自己判。**不调用** enabledNotificationChannels——那等于把实现抄进测试。 */
function channelsFromContract(c: IdentityContract): string[] {
  const env = (k: string) => (process.env[k] ?? '').trim();
  const portRaw = env('EWOH_SMTP_PORT');
  const port = portRaw === '' ? 587 : Number(portRaw);
  const tos = env('EWOH_SMTP_TO').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const emailOk = env('EWOH_SMTP_HOST') !== '' && env('EWOH_SMTP_FROM') !== ''
    && tos.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535;
  return c.channels.filter((ch) => {
    if (ch.enabled_when === 'always') return true;
    if (ch.enabled_when.includes('EWOH_LARK_WEBHOOK_URL')) return env('EWOH_LARK_WEBHOOK_URL') !== '';
    if (ch.enabled_when.includes('EWOH_SMTP_HOST')) return emailOk;
    throw new Error(`[CC] 契约里出现本例不认识的 enabled_when：${ch.enabled_when} ⇒ 加渠道时要同批改这里的判法`);
  }).map((ch) => ch.name);
}

const sanitize = (v: string, max: number) => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max);

/** 期望 id 全集＝（契约收件人 × 契约渠道），按契约的 id 形状与截断长度拼出来。 */
function expectedIds(c: IdentityContract, commandId: string, bucket: 'delivery_revoked' | 'unauthorized_execution'): string[] {
  const spec = c.buckets[bucket];
  const prefix = `NTF-CTRL-${sanitize(commandId, 80)}-`;
  const channels = channelsFromContract(c);
  return spec.recipients.flatMap((r) => channels.map((ch) => {
    const raw = `${prefix}${bucket}-${sanitize(r.type, 40)}-${sanitize(r.id, 40)}-${ch}`;
    return raw.slice(0, c.id_slice_chars);
  }));
}

interface NotificationRow {
  notification_id: string;
  external_ref: string | null;
  severity: string | null;
  channel?: string | null;
}

(config ? describe : describe.skip)(
  '控制命令提醒身份 E2E（真实 PostgreSQL，零时钟两桶的契约派生等式）',
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
      await owner?.end?.();
    });

    /** 建立一条低危命令：create → send，返回 requestId 与 commandId（台账 status=sent）。 */
    async function createSentCommand(tag: string): Promise<{ requestId: string; commandId: string }> {
      const created = await apiRequest<{ id: string }>(handle.baseUrl, '/api/control/requests', {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({
          deviceId: `AGV-CC-${tag}`,
          commandKeys: ['start'],
          idempotencyKey: `cc-${tag}`,
        }),
      });
      expect(created.status).toBe(201);
      const requestId = created.body.id;
      const sent = await apiRequest<{ attempts?: { attemptId: string; commandKey: string }[] }>(
        handle.baseUrl,
        `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ commandKey: 'start', payload: {} }),
        },
      );
      expect(sent.status).toBe(201);
      const attempt = (sent.body.attempts ?? []).find((item) => item.commandKey === 'start');
      expect(attempt).toBeTruthy();
      return { requestId, commandId: attempt!.attemptId };
    }

    const gatewayHeaders = () => ({
      'content-type': 'application/json',
      'x-ingest-key': INGEST_KEY,
      'x-org-id': fixture.orgA.id,
    });

    const drainPending = (deviceId: string) => apiRequest<{
      commands?: unknown[];
      revoked?: number;
      deferred?: unknown[];
    }>(handle.baseUrl, `/api/control/commands/pending?deviceId=${deviceId}&limit=10`, {
      method: 'GET',
      headers: gatewayHeaders(),
    });

    async function commandRow(commandId: string) {
      const [row] = await owner`
        select status, revoked_at, revoked_reason, org_id from ewoh_control_command
        where command_id = ${commandId}`;
      expect(row).toBeTruthy();
      return row as { status: string; revoked_at: Date | null; revoked_reason: string | null; org_id: string };
    }

    async function ctrlRows(commandId: string): Promise<NotificationRow[]> {
      const prefix = `NTF-CTRL-${sanitize(commandId, 80)}-`;
      return await owner<NotificationRow[]>`
        select notification_id, external_ref, severity from public.ewoh_notification
        where notification_id like ${prefix + '%'} order by notification_id`;
    }

    /** 集合相等：逐项 id 与条数同时核（条数不核的话，"多一行"与"少一行"会互相抵消成看不出）。 */
    function expectSetEquals(rows: NotificationRow[], want: string[]) {
      const got = rows.map((r) => String(r.notification_id)).sort();
      expect(got.length).toBe(want.length);
      expect(got).toEqual([...want].sort());
    }

    it('CC-01 前提：投递前授权被撤 ⇒ drain 确实把命令收成 revoked 并带原因码（事实先落地，才有可对的投影）', async () => {
      const deviceId = `AGV-CC-rev-${runId}`;
      const { requestId, commandId } = await createSentCommand(`rev-${runId}`);
      // 前提构造走 owner 直写：撤的是**授权来源**（请求行），而撤回的**生产方**仍是被测代码。
      await owner`update public.ewoh_control_request set status = 'revoked' where request_id = ${requestId}`;
      expect((await commandRow(commandId)).status).toBe('sent');

      const drained = await drainPending(deviceId);
      expect(drained.status).toBeLessThan(400);

      const after = await commandRow(commandId);
      expect(after.status).toBe('revoked');
      expect(after.revoked_reason).toBeTruthy();
      expect(after.revoked_at).not.toBeNull();
    });

    it('CC-02 delivery_revoked 等式：落库提醒集合＝契约重算集合（id／条数／external_ref／severity 四项同核）', async () => {
      const c = identity();
      const deviceId = `AGV-CC-eq-${runId}`;
      const { requestId, commandId } = await createSentCommand(`eq-${runId}`);
      await owner`update public.ewoh_control_request set status = 'revoked' where request_id = ${requestId}`;
      expect((await drainPending(deviceId)).status).toBeLessThan(400);
      expect((await commandRow(commandId)).status).toBe('revoked');

      // 投影侧读取写在**块内字面**（helper 里的表名对本格判据不可见；两算要能在同一块里读到两边）
      const rows = await owner<NotificationRow[]>`
        select notification_id, external_ref, severity from public.ewoh_notification
        where notification_id like ${`NTF-CTRL-${sanitize(commandId, 80)}-%`} order by notification_id`;
      // 非空前提：读空集时"集合相等"会退化成两边都是空的恒真。
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, expectedIds(c, commandId, 'delivery_revoked'));
      for (const row of rows) {
        expect(String(row.external_ref)).toBe(commandId);
        expect(String(row.severity)).toBe(c.buckets.delivery_revoked.severity);
      }
      // 两算的第二算：投影声称的那条主事实必须在权威表里。
      const [exists] = await owner`
        select 1 as hit from public.ewoh_control_command
        where command_id = ${commandId} and status = 'revoked' and revoked_at is not null`;
      expect(exists).toBeTruthy();
    });

    it('CC-03 unauthorized_execution 等式：撤回后设备仍执行 ⇒ 该桶集合相等，且违规结果行同在', async () => {
      const c = identity();
      const { commandId } = await createSentCommand(`ue-${runId}`);
      await owner`
        update public.ewoh_control_command
        set status = 'revoked', revoked_at = now(), revoked_reason = 'authorization_revoked'
        where command_id = ${commandId}`;
      const receipt = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { ack: 'late' } }),
      });
      expect(receipt.status).toBeLessThan(400);

      const [violation] = await owner`
        select 1 as hit from public.ewoh_control_result
        where command_id = ${commandId} and result_type = 'authorization_violation'`;
      expect(violation).toBeTruthy();

      const rows = (await ctrlRows(commandId)).filter((r) => String(r.notification_id).includes('-unauthorized_execution-'));
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, expectedIds(c, commandId, 'unauthorized_execution'));
      for (const row of rows) {
        expect(String(row.external_ref)).toBe(commandId);
        expect(String(row.severity)).toBe(c.buckets.unauthorized_execution.severity);
      }
    });

    it('CC-04 幂等：同一事实再触发一次 ⇒ 行数与 id 集合一字不动（唯一键吞掉，不多一行也不报错）', async () => {
      const deviceId = `AGV-CC-idem-${runId}`;
      const { requestId, commandId } = await createSentCommand(`idem-${runId}`);
      await owner`update public.ewoh_control_request set status = 'revoked' where request_id = ${requestId}`;
      expect((await drainPending(deviceId)).status).toBeLessThan(400);
      const before = await ctrlRows(commandId);
      expect(before.length).toBeGreaterThan(0);

      // 再 drain 一次（命令已 revoked，不在窗口里）＋ 再发一条重复回执：提醒不得翻倍。
      expect((await drainPending(deviceId)).status).toBeLessThan(400);
      const dup = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { ack: 'late-2' } }),
      });
      expect(dup.status).toBeLessThan(500);

      const after = await ctrlRows(commandId);
      expect(after.map((r) => String(r.notification_id)).sort())
        .toEqual(before.map((r) => String(r.notification_id)).sort());
      expect(after.length).toBe(before.length);
    });

    it('CC-05 无幽灵：正常投递且未被撤回的命令 ⇒ 它的前缀下必须 0 行（否则等式两边都有行即恒真）', async () => {
      const deviceId = `AGV-CC-ok-${runId}`;
      const { commandId } = await createSentCommand(`ok-${runId}`);
      const delivered = await drainPending(deviceId);
      expect(delivered.status).toBeLessThan(400);
      const receipt = await apiRequest(handle.baseUrl, `/api/control/commands/${commandId}/receipt`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ result: 'executed', receipt: { ack: 'first' } }),
      });
      expect(receipt.status).toBeLessThan(400);
      expect((await commandRow(commandId)).status).toBe('executed');
      expect(await ctrlRows(commandId)).toEqual([]);
    });
  },
);
