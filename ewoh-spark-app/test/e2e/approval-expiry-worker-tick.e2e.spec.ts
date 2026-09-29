/**
 * 授权到期提醒**周期触发**路径（RECOV-02，V207 新立常驻位点）。
 *
 * 问法与 `control-backlog-worker-tick`（V206，WB-01/WB-02）完全同形，只是换一张权威表：
 * `ApprovalExpiryWorkerService` 的 setInterval 默认 **300_000ms＝5 分钟**，而链上常驻用例的等待窗
 * 都在 10–40s 量级 ⇒ 窗内 0 次 tick。既有证据全部来自 `e2e:approval-expiry` 场景脚本，
 * 它**每一步都显式 POST /api/approvals/authorizations/expiry-sweep**（该脚本 :147/:174/:184/:268）
 * ⇒ 覆盖的是"有人来扫会怎样"，没覆盖"没人来扫、只有 worker 到点，提醒会不会自己出现"。
 * 生产里承担后者的正是这个 worker。
 *
 * 两支成对断言（缺一支就是没证到）：
 *  - AE-01 间隔 2s：整支用例**一次都不调 sweep**，回拨审批实例时间造出"剩余 ≈1 小时"的授权
 *    ⇒ 提醒行必须由 worker 的 tick 自己长出来（`NTF-EXPR-<审批号>-expiring…`，severity=high）；
 *  - AE-02 反证：同一前提、同一等待时长，只把间隔设成 **300000ms＝生产默认** ⇒ 提醒行必须**不存在**。
 *    否则 AE-01 的"出现"就可能来自别的机制（拦截器、别的定时器、上一支用例的残留）。
 *
 * 夹具口径：接收人用 `workshop_lead`（fixture 里 approverA 名下唯一可用的真实角色；
 * 场景脚本用的 `safety_admin` 在进程内 fixture 里没有成员，提醒会因"无接收人"而不落行）。
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
/** 收敛确证的上限；同时是反证支"等同样久"的那个时长。 */
const WAIT_MS = 40_000;

/* ── AE-03 用的契约派生 oracle（V261）────────────────────────────────────────
 * 问法与 KC-01..06／BS-05/06 同族：`ewoh_notification` 里"授权到期"这批行是**派生投影**，
 * 它的身份（谁的、哪个桶、哪条渠道、什么 id）由 `contracts/state-machines/approval.yaml` 的
 * `expiry_notification_identity` 定义。本例从契约自己重算期望集合，再与实现落库的行逐项比。
 * 两条牙齿（V254 的教训：**同时改两侧会互相抵消**，所以两侧各量一次，见 §5.3lf）：
 *   ① 实现侧：把 approval-expiry.service 的 severity 或收件人规则改回去 ⇒ 等式必须红；
 *   ② 契约侧：改本块的 id_shape/enabled_when 而不同步改实现 ⇒ 等式必须红；
 *      而**改实现不同步改契约**也红——这正是"口径提出来"换来的东西。
 * 读不到契约块 ⇒ 抛，不静默跳过（"跳过"与"通过"在终端上同形）。
 */
type ExpiryIdentity = {
  projection_table: string;
  authority_table: string;
  id_shape: string;
  recipient_tag_shape: string;
  id_slice_chars: number;
  bucket_window_hours: number;
  severity_by_bucket: Record<string, string>;
  channels: Array<{ name: string; enabled_when: string }>;
};

const IDENTITY_CONTRACT_PATH = resolve(__dirname, '../../../contracts/state-machines/approval.yaml');

function expiryIdentity(): ExpiryIdentity {
  const doc = load(readFileSync(IDENTITY_CONTRACT_PATH, 'utf8')) as { expiry_notification_identity?: ExpiryIdentity };
  const w = doc.expiry_notification_identity;
  if (!w || !w.id_shape || !Array.isArray(w.channels) || !w.severity_by_bucket) {
    throw new Error(
      `[AE-03] 契约 approval.yaml 里没有可读的 expiry_notification_identity ⇒ 期望集合无从重算；`
      + `判不可用（抛）而不是跳过：跳过与通过同形。`,
    );
  }
  return w;
}

/** 渠道启用：逐条按契约写的 env 谓词自己判。**不调用** isLarkPushEnabled/isEmailPushEnabled——那等于把实现抄进测试。 */
function enabledChannelsFromContract(w: ExpiryIdentity): string[] {
  const env = (k: string) => (process.env[k] ?? '').trim();
  const portRaw = env('EWOH_SMTP_PORT');
  const port = portRaw === '' ? 587 : Number(portRaw);
  const emailRecipients = env('EWOH_SMTP_TO').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const emailOk = env('EWOH_SMTP_HOST') !== '' && env('EWOH_SMTP_FROM') !== ''
    && emailRecipients.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535;
  return w.channels.filter((c) => {
    if (c.enabled_when === 'always') return true;
    if (c.enabled_when.includes('EWOH_LARK_WEBHOOK_URL')) return env('EWOH_LARK_WEBHOOK_URL') !== '';
    if (c.enabled_when.includes('EWOH_SMTP_HOST')) return emailOk;
    throw new Error(`[AE-03] 契约里出现本例不认识的 enabled_when：${c.enabled_when} ⇒ 加新渠道时要同批改这里的判法`);
  }).map((c) => c.name);
}

/** 期望的 notification_id 全集＝收件人规则 × 渠道规则 的笛卡儿积，按契约形状与截断长度拼出来。 */
function expectedExpiryNotificationIds(w: ExpiryIdentity, approvalId: string, requester: string): string[] {
  const recipients: Array<{ type: 'role' | 'user'; id: string }> = [{ type: 'role', id: 'safety_admin' }];
  const trimmed = (requester ?? '').trim();
  if (trimmed !== '' && trimmed !== 'system') {
    recipients.push({ type: 'user', id: trimmed.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) });
  }
  const out: string[] = [];
  for (const r of recipients) {
    for (const channel of enabledChannelsFromContract(w)) {
      const tag = r.type === 'user' ? `-user-${r.id}` : '';
      out.push(`NTF-EXPR-${approvalId}-expiring${tag}-${channel}`.slice(0, w.id_slice_chars));
    }
  }
  return out;
}

(config ? describe : describe.skip)(
  '授权到期提醒 worker 的周期触发（没有人调 expiry-sweep，提醒会不会自己出现）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    const runId = randomUUID().slice(0, 8);
    /**
     * 本文件自己的 owner 会话也必须有**唯一** application_name。第三遍全量重放实测：不加名字的 owner 会话
     * 在 `pg_stat_activity` 里叫 `postgres.js`，而外来 standalone 后端的连接同样叫 `postgres.js`
     * ⇒ 允许名单里"排除匿名"与"抓住外来者"两件事不可能同时成立。名字自铸之后，匿名一律算外来客户端。
     */
    const ownerApplicationName = `ewoh-e2e-owner-${runId}`;
    /**
     * 应用自带的 `RetentionService` 用 `EWOH_DATABASE_URL` 自开一个 owner 连接池（不套应用的连接串），
     * 因此在 `pg_stat_activity` 里是匿名的——第三遍重放那次 `postgres.js×1` 就是它
     * （`ewoh_owner/idle/SELECT id FROM ewoh_event …`，它只按保留窗删 24h/7d 之前的行，删不到本用例 23h 前的前提，
     * 也不碰 `ewoh_notification`）。这里把它的连接也铸上本文件派生的名字，允许名单就只剩"本文件铸出来的三个名字"；
     * 外来的 standalone 后端仍然匿名 ⇒ 抓得住。收尾必须还原原值（jest 同 worker 多文件共用 process）。
     */
    const retentionApplicationName = `${ownerApplicationName}-retention`;
    let savedOwnerPoolUrl: string | undefined;

    beforeAll(async () => {
      const ownerUrl = new URL(config!.ownerDatabaseUrl);
      ownerUrl.searchParams.set('application_name', ownerApplicationName);
      owner = await connectOwner(ownerUrl.toString());
      const retentionUrl = new URL(config!.ownerDatabaseUrl);
      retentionUrl.searchParams.set('application_name', retentionApplicationName);
      savedOwnerPoolUrl = process.env.EWOH_DATABASE_URL;
      process.env.EWOH_DATABASE_URL = retentionUrl.toString();
      fixture = await createE2EFixture(owner);
    }, 180_000);

    afterAll(async () => {
      if (savedOwnerPoolUrl === undefined) delete process.env.EWOH_DATABASE_URL;
      else process.env.EWOH_DATABASE_URL = savedOwnerPoolUrl;
      expect(process.env.EWOH_DATABASE_URL).toBe(savedOwnerPoolUrl);
      // 间隔是**进程级** env，jest 同 worker 多文件共用 process ⇒ 必须清掉并断言已清（V206 同族）。
      delete process.env.APPROVAL_EXPIRY_WORKER_INTERVAL_MS;
      delete process.env.APPROVAL_EXPIRY_WORKER_DISABLED;
      expect(process.env.APPROVAL_EXPIRY_WORKER_INTERVAL_MS).toBeUndefined();
      if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      await owner?.end();
    });

    async function bootWith(intervalMs: string) {
      process.env.APPROVAL_EXPIRY_WORKER_INTERVAL_MS = intervalMs;
      const handle = await startE2EApp(config!, fixture.orgA.id);
      const admin = await login(handle.baseUrl, fixture.globalAdminA.username, fixture.globalAdminA.password);
      const creator = await login(handle.baseUrl, fixture.approverA.username, fixture.approverA.password);
      expect(admin.status).toBe(201);
      expect(creator.status).toBe(201);
      return { handle, adminToken: admin.body.accessToken, creatorToken: creator.body.accessToken };
    }

    /** 真造一张"已通过且剩余有效期 ≈1 小时"的授权：产品路径建单＋另一身份批准＋回拨实例时间。 */
    async function plantExpiringAuthorization(handle: E2EAppHandle, creatorToken: string, adminToken: string, tag: string) {
      const created = await apiRequest<{ id?: string; steps?: { id: string }[] }>(
        handle.baseUrl, '/api/approvals',
        {
          method: 'POST',
          headers: jsonHeaders(creatorToken),
          body: JSON.stringify({
            entityType: 'device_capability_change',
            entityId: `capability:exo-tick-${runId}`,
            roles: ['workshop_lead'],
            subject: {
              objectType: 'device_capability_change',
              objectId: `capability:exo-tick-${runId}`,
              title: `周期触发验证 ${tag}`,
              summary: `e2e（run=${runId}）：${tag} 到期提醒的周期触发路径`,
              metrics: { capabilityKey: 'exo-tick', deviceIds: `EXO-TICK-${runId}` },
            },
          }),
        },
      );
      expect(created.status).toBe(201);
      const approvalId = String(created.body.id);
      const stepId = String(created.body.steps?.[0]?.id);
      const approved = await apiRequest(
        handle.baseUrl, `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`,
        { method: 'POST', headers: jsonHeaders(adminToken), body: JSON.stringify({ reason: `e2e ${tag} 通过` }) },
      );
      expect([200, 201]).toContain(approved.status);
      // 回拨到 23 小时前 ⇒ 24h 有效期的授权剩 ≈1 小时，落进 `expiring`（≤2h）桶。
      // 键与场景脚本逐字一致：审批实例落在通用事件表，业务键是 `event_id`（`id` 是行主键，撞不到）。
      const backdated = await owner`
        update public.ewoh_event
           set _updated_at = now() - interval '23 hours'
         where event_id = ${approvalId} and event_type = 'approval_instance'
           returning event_id as "id"`;
      expect(backdated.length).toBe(1);
      return approvalId;
    }

    async function expiryNotifications(approvalId: string) {
      const rows = await owner`
        select notification_id as "notificationId", severity, status
          from public.ewoh_notification
         where notification_id like ${`NTF-EXPR-${approvalId}-%`}`;
      return rows as unknown as Array<{ notificationId: string; severity: string; status: string }>;
    }

    /**
     * 前提护栏：两支用例靠"只有本用例的 worker 在动"来区分 ⇒ **这个库里不许有第三个客户端连接**。
     * V207 实测两次，两次的修法不同：
     *  ① 第二遍全量重放——C 段起的 standalone 后端活到脚本退出，与 D 段的进程内应用共用同一个库，
     *     它带着授权到期 worker 的默认 300s 间隔继续扫全库，把 AE-02 的"40s 内不许落行"顶红
     *     （harness 侧修法：verify.sh 进 D 段前就关掉它）；
     *  ② 第三遍全量重放——关掉之后 AE-02 仍红，但红在**前提**且两档同红（可复现）：来者是本文件自己的
     *     owner 会话，它没设 application_name，在 `pg_stat_activity` 里以驱动默认名 `postgres.js` 现身，
     *     而 ①那种外来后端同样叫 `postgres.js` ⇒ "排除匿名"会把要抓的东西一起放进来。
     * 修法＝本文件的会话自己铸名（见 `ownerApplicationName`），允许名单只认"本应用＋本 owner 会话"两个名字，
     * 其余（含匿名）一律算外来者：将来再有别的过程接进来，红的是前提说明，不是结论被误读。
     */
    async function otherClients(handle: E2EAppHandle): Promise<string[]> {
      // 外来者只报"名字×数量"不够用：第三遍重放实测过一次 `postgres.js×1`，光看名字定不了是谁。
      // 于是把 用户/状态/最后一条语句/建连时刻 一起带出来，红一次就能直接归因，不必再补一次复跑。
      const rows = await owner`
        select coalesce(nullif(application_name, ''), '<no-application_name>') as "app",
               count(*)::int as "n",
               string_agg(
                 usename || '/' || state || '/' || coalesce(left(query, 70), '-') || '@' ||
                 to_char(backend_start, 'HH24:MI:SS'),
                 ' | ' order by pid
               ) as "detail"
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and application_name is distinct from ${handle.databaseApplicationName}
           and application_name is distinct from ${ownerApplicationName}
           and application_name is distinct from ${retentionApplicationName}
         group by 1
         order by 1`;
      return rows.map(
        (r: Record<string, unknown>) => `${r.app}×${r.n} [${r.detail}]`,
      );
    }
    async function expectOnlyThisApp(handle: E2EAppHandle, where: string) {
      const others = await otherClients(handle);
      if (others.length > 0) {
        throw new Error(
          `[${where}] 反证前提失效：同一个库里还有别的客户端在跑（${others.join(', ')}），`
          + `它们的 worker 会替本用例改掉"不该出现的行"。允许名单只有本文件铸出来的三个名字：`
          + `应用 ${handle.databaseApplicationName}、本文件 owner 会话 ${ownerApplicationName}、`
          + `应用自带的保留清理连接 ${retentionApplicationName}（其余含匿名一律算外来者）`,
        );
      }
    }

    it('AE-01 间隔 2s：不调 sweep，到期提醒应由 worker 的 tick 自己落行', async () => {
      const { handle, adminToken, creatorToken } = await bootWith('2000');
      try {
        const approvalId = await plantExpiringAuthorization(handle, creatorToken, adminToken, 'AE-01');
        const deadline = Date.now() + WAIT_MS;
        let rows: Awaited<ReturnType<typeof expiryNotifications>> = [];
        let polls = 0;
        // 确证式等待：循环体内既有真等待原语又有终态检查（分不清"还没到点"与"永远不到点"的读法等于没断）。
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          polls += 1;
          rows = await expiryNotifications(approvalId);
          if (rows.length > 0) break;
        }
        console.log(`[AE-01] 等待 ${polls}s（interval=2000ms）提醒行=${JSON.stringify(rows)}`);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => /-expiring/.test(r.notificationId))).toBe(true);
        expect(rows.every((r) => r.severity === 'high')).toBe(true);
      } finally {
        await handle.close();
      }
    }, 180_000);

    it('AE-02 反证：间隔 300s（生产默认）时同样时长内不落行 ⇒ AE-01 的推进确实来自 worker', async () => {
      const { handle, adminToken, creatorToken } = await bootWith('300000');
      try {
        const approvalId = await plantExpiringAuthorization(handle, creatorToken, adminToken, 'AE-02');
        await expectOnlyThisApp(handle, 'AE-02');
        await new Promise((r) => setTimeout(r, WAIT_MS));
        const rows = await expiryNotifications(approvalId);
        console.log(
          `[AE-02] 等 ${WAIT_MS / 1000}s（interval=300000ms＝生产默认）提醒行数=${rows.length} 行=${JSON.stringify(rows)} 其他客户端=${(await otherClients(handle)).join(',') || '无'}`,
        );
        expect(rows.length).toBe(0);
      } finally {
        await handle.close();
      }
    }, 180_000);

    /**
     * AE-03（V261）**投影身份可重算**：`ewoh_notification` 里这批"到期提醒"行是派生投影，
     * 它的期望集合由契约（`expiry_notification_identity`）独立重算＝收件人规则 × 渠道规则 的笛卡儿积，
     * 再与实现落库的行**逐项比 id**（不是"存在一条"），并断重复 sweep 不新增。
     * 三条前提断言（缺任何一条，等式就可能是恒真）：
     *  ① 源侧真有一行权威事实（`ewoh_event` 的 approval_instance，且它带着发起人）——读空⇒两边都空；
     *  ② 桶由契约窗口算出，不是写死 'expiring'；
     *  ③ 期望集合 ≥2 条（角色一条＋发起人一条，NO-32a 那一半）——若实现漏掉发起人，等式必须红。
     */
    it('AE-03 通知身份可重算：行集合＝契约(收件人规则 × 渠道规则)的笛卡儿积，重复 sweep 不新增', async () => {
      const w = expiryIdentity();
      const { handle, adminToken, creatorToken } = await bootWith('2000');
      try {
        const approvalId = await plantExpiringAuthorization(handle, creatorToken, adminToken, 'AE-03');
        const requester = fixture.approverA.username;
        // 前提①：源侧（权威表）确有这一条，且携带发起人
        const source = await owner`
          select event_id as "id", evidence_json::text as "raw"
            from public.ewoh_event
           where event_id = ${approvalId} and event_type = 'approval_instance'`;
        expect(source.length).toBe(1);
        expect(String(source[0].raw)).toContain(requester);
        // 前提②：桶按契约窗口算（有效期 24h、回拨 23h ⇒ 剩 1h），再断它确实是本例种下的那个桶
        const remainingHours = 24 - 23;
        const bucket = remainingHours <= w.bucket_window_hours ? 'expiring' : 'expired';
        expect(bucket).toBe('expiring');
        // 前提③：期望集合至少两条（角色 + 发起人）
        const expected = expectedExpiryNotificationIds(w, approvalId, String(requester));
        expect(expected.length).toBeGreaterThanOrEqual(2);
        // 确证式等待（循环体内既有真等待原语又有终态检查）
        const deadline = Date.now() + WAIT_MS;
        let rows: Awaited<ReturnType<typeof expiryNotifications>> = [];
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          rows = await expiryNotifications(approvalId);
          if (rows.length > 0) break;
        }
        console.log(
          `[AE-03] 契约重算期望=${JSON.stringify(expected.sort())} 实现落库=${JSON.stringify(rows.map((r) => r.notificationId).sort())}`,
        );
        expect(rows.map((r) => r.notificationId).sort()).toEqual([...expected].sort());
        for (const r of rows) {
          expect(r.severity).toBe(w.severity_by_bucket[bucket]);
          expect(r.status).toBe('pending');
        }
        // 幂等半边：显式再扫一遍，行数与 id 集合都不许变（契约的 onConflictDoNothing 那一行）
        const swept = await apiRequest(
          handle.baseUrl, '/api/approvals/authorizations/expiry-sweep',
          { method: 'POST', headers: jsonHeaders(adminToken) },
        );
        expect(swept.status).toBe(200);
        const again = await expiryNotifications(approvalId);
        expect(again.map((r) => r.notificationId).sort()).toEqual([...expected].sort());
      } finally {
        await handle.close();
      }
    }, 180_000);
  },
);
