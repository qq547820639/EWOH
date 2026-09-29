/**
 * 安灯提醒的身份到底等不等？（V270：NOTIFICATION_FANOUT 格的 andon 腿第一条契约派生等式）
 *
 * 问法：`ewoh_notification` 里 `NTF-ANDON-…` 这批行是**派生投影**（由安灯主事实 + 桶规则 +
 * 收件人规则 + 渠道开关算出）。口径此前只写在服务里（`andon-notifications.ts` / `oee.service.ts`），
 * 所以"改了桶序号或收件人清单会不会红"没有落点。本轮把口径提进
 * `contracts/state-machines/alert.yaml` 的 `andon_notification_identity`，本文件**从契约自己拼期望集合**
 * （前缀形状、收件人规则、渠道 enabled_when、截断长度都取自该块），再与落库行做**集合相等**比较。
 *
 * 既有覆盖到底钉到哪一层（按断言语义搜过，不是按登记位点查）：
 *  - `test/unit/oee/oee.service.spec.ts` 的「第二次重开落新 id」——**mock db**：mock 的
 *    `insert().values().onConflictDoNothing().returning()` 无论是否冲突都把行返回，
 *    所以"被唯一键静默吞掉"这个**后果**在 mock 里结构上不可表示。它钉的是 id 字符串形状，不是幂等键行为。
 *  - `test/e2e/ewoh-http.e2e.spec.ts` 的开灯断言：`toHaveLength(2)` + 两个 `some(/-raised-/)`，
 *    且落在**未列入 CHAIN_SPECS** 的 spec（不进每遍重放）。
 *  ⇒ 真正缺的是"重开腿在真实唯一键上的等式"，本文件补这一格。
 *
 * 五支断言：
 *  - AND-01 前提：该 deviceId 在 `ewoh_device_responsibility` 里 0 行 ⇒ raised 腿的收件人集合
 *          完全由契约的 role 规则决定（否则期望集合的构成要过班次解析，那半不可事后重算）；
 *  - AND-02 开灯等式：落库行集合 ＝ 契约重算集合（逐项 id，且条数相等）；
 *  - AND-03 重开序号等式：两次「关灯→重开」后，桶必须是 `reopened` 与 `reopened-2`
 *          （k 由**该安灯行的 evidence_json.timeline 现数**，不调用被测的 andonReopenedBucket）；
 *  - AND-04 幂等：从 reopened 态再发一次 reopen 被拒 ⇒ 行数与 id 集合一字不动
 *          （唯一键路径的另一半：同一桶不得出现第二条）；
 *  - AND-05 了结：关灯后**全部桶**（raised / reopened / reopened-2）的提醒都带 resolution='andon_cleared'
 *          与 resolved_at，且重开不复活旧行（新一次重开只新增自己的桶）。
 *
 * 限度（引用这一格之前要一起说）：等式覆盖的是 role 半；设备责任人的 user 半与三条 SLA 桶挂在
 * `new Date()` 上（班次解析 / ageSeconds vs slaSeconds），事后重算会翻档 ⇒ 契约里单列
 * `not_recomputable`，本文件不硬写那两半。
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
const CONTRACT_PATH = resolve(__dirname, '../../../contracts/state-machines/alert.yaml');

interface IdentityContract {
  projection_table: string;
  authority_table: string;
  prefix_shape: string;
  id_shape: string;
  id_slice_chars: number;
  buckets: Record<
    'raised' | 'reopened',
    { recipients: Array<{ type: 'role'; id?: string; id_from?: string; default?: string }>; severity: { default: string } }
  >;
  channels: Array<{ name: string; enabled_when: string }>;
}

function identity(): IdentityContract {
  const doc = load(readFileSync(CONTRACT_PATH, 'utf8')) as { andon_notification_identity?: IdentityContract };
  const c = doc.andon_notification_identity;
  if (!c || !c.prefix_shape || !c.id_shape || !c.buckets?.raised || !c.buckets?.reopened || !Array.isArray(c.channels)) {
    throw new Error(`[AND] 契约 alert.yaml 里读不到 andon_notification_identity ⇒ 期望集合无从重算（判不可用=抛，不静默跳过）`);
  }
  return c;
}

/** 渠道启用：逐条按契约写的 env 谓词自己判。**不调用** enabledNotificationChannels/isLarkPushEnabled——那等于把实现抄进测试。 */
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
    throw new Error(`[AND] 契约里出现本例不认识的 enabled_when：${ch.enabled_when} ⇒ 加渠道时要同批改这里的判法`);
  }).map((ch) => ch.name);
}

const sanitize = (v: string, max: number) => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max);

/** 期望 id 全集＝（桶 × 契约收件人规则 × 契约渠道），按契约的 id 形状与截断长度拼出来。 */
function expectedIds(
  c: IdentityContract,
  eventId: string,
  bucket: 'raised' | string,
  facts: { assignee: string; severity: string },
): string[] {
  const key = bucket === 'raised' ? 'raised' : 'reopened';
  const rule = c.buckets[key];
  const channels = channelsFromContract(c);
  const out: string[] = [];
  for (const r of rule.recipients) {
    const raw = r.id ?? (r.id_from === 'assignee' ? facts.assignee : r.default ?? '');
    const recipient = sanitize(String(raw), 40);
    for (const channel of channels) {
      out.push(
        `NTF-ANDON-${sanitize(eventId, 80)}-${bucket}-${r.type}-${recipient}-${channel}`.slice(0, c.id_slice_chars),
      );
    }
  }
  return out;
}

(config ? describe : describe.skip)(
  '安灯提醒身份的契约派生等式（V270：andon 腿的桶序号／收件人／渠道在真实唯一键上对不对）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    const runId = randomUUID().slice(0, 8);
    const deviceId = `ANDON-ID-${runId}`;
    const assignee = `worker.${runId}`;
    const contract = identity();
    let eventId = '';
    let tokens: { handler: string; admin: string } = { handler: '', admin: '' };

    beforeAll(async () => {
      if (!config) return;
      owner = await connectOwner(config.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config, fixture.orgA.id);
      const h = await login(handle.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password);
      const a = await login(handle.baseUrl, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(h.status).toBe(201);
      expect(a.status).toBe(201);
      tokens = { handler: h.body.accessToken, admin: a.body.accessToken };
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      await owner?.end();
    });

    async function action(path: string, token: string) {
      return apiRequest<{ status?: string; eventId?: string; message?: string }>(
        handle.baseUrl, path, { method: 'POST', headers: jsonHeaders(token), body: '{}' },
      );
    }

    /** 权威状态列（每次推进都从库里读，不靠测试自己记状态）。 */
    async function statusOf(id: string): Promise<string> {
      const [row] = await owner.unsafe<Array<{ status: string }>>(
        `select status from public.ewoh_event where event_id = $1`,
        [id],
      );
      return String(row?.status);
    }

    /**
     * 把这条安灯按契约状态机允许的路推回 closed（供重开循环复用）。
     * 每一步都断 2xx——**不许**用"接受 400"来吞掉非法边：AND-04 那类"重复动作被拒"的断言
     * 只有在本例真的处在它声称的那个态时才算数（第一版就是靠 open 态下 reopen 也被拒蒙过去的）。
     */
    async function closeOut(id: string, token: string) {
      const seq: Record<string, string[]> = {
        open: ['acknowledge', 'process', 'close'],
        acknowledged: ['process', 'close'],
        processing: ['close'],
        reopened: ['acknowledge', 'process', 'close'],
      };
      const steps = seq[await statusOf(id)];
      if (!steps) throw new Error(`[AND] closeOut：起始态 ${await statusOf(id)} 不在预期集合里`);
      for (const a of steps) {
        const r = await action(`/api/oee/andons/${id}/state?action=${a}`, token);
        expect([200, 201]).toContain(r.status);
      }
      expect(await statusOf(id)).toBe('closed');
    }

    /** 该安灯的全部提醒行（按契约前缀取）。表名写成**字面量**：`projection-consistency` 的 two-sided
     *  判据看的是 `it()` 块内的字面表名，经变量插值它读不到（V261 的 AE-03 就是这么停在 existence 的）。 */
    async function rows(id: string) {
      return owner.unsafe<Array<{
        notification_id: string; recipient_type: string; recipient_id: string; external_ref: string | null;
        channel: string; severity: string; status: string; resolution: string | null; resolved_at: Date | null;
      }>>(
        `select notification_id, recipient_type, recipient_id, external_ref, channel, severity, status, resolution, resolved_at
           from public.ewoh_notification
          where notification_id like $1
          order by notification_id`,
        [`NTF-ANDON-${sanitize(id, 80)}-%`],
      );
    }

    /** 第几次重开＝权威行 timeline 里 type=='reopen' 的条数（契约 bucket_rule；不调被测函数）。 */
    async function reopenCount(id: string): Promise<number> {
      const [row] = await owner.unsafe<Array<{ evidence_json: { timeline?: Array<{ type?: string }> } | null }>>(
        `select evidence_json from public.ewoh_event where event_id = $1`,
        [id],
      );
      const timeline = row?.evidence_json?.timeline ?? [];
      return timeline.filter((e) => e?.type === 'reopen').length;
    }

    const sorted = (xs: string[]) => [...xs].sort();

    it('AND-01 前提：该设备没有登记责任关系 ⇒ raised 腿的收件人完全由契约决定', async () => {
      if (!config) return;
      const rowsSeen = await owner.unsafe<Array<{ n: string | number }>>(
        `select count(*)::text as n from public.ewoh_device_responsibility where device_id = $1`,
        [deviceId],
      );
      expect(String(rowsSeen[0]?.n)).toBe('0');
      const opened = await apiRequest<{ eventId: string; status: string }>(
        handle.baseUrl, '/api/oee/andons',
        {
          method: 'POST',
          headers: jsonHeaders(tokens.handler),
          body: JSON.stringify({ deviceId, title: `身份等式验证 ${runId}`, reason: 'e2e', severity: 'high', assignee }),
        },
      );
      expect(opened.status).toBe(201);
      expect(opened.body.status).toBe('open');
      eventId = String(opened.body.eventId);
      expect(eventId).not.toBe('');
    });

    it('AND-02 开灯等式：落库行集合 ＝ 契约重算集合（逐项 id + 条数）', async () => {
      if (!config) return;
      const got = await rows(eventId);
      // 前提非恒真：没有行时"集合相等"会空转 ⇒ 先钉它确实长了行
      expect(got.length).toBeGreaterThan(0);
      expect(sorted(got.map((r) => r.notification_id))).toEqual(
        sorted(expectedIds(contract, eventId, 'raised', { assignee, severity: 'high' })),
      );
      for (const r of got) {
        expect(r.external_ref).toBe(eventId);
        expect(r.recipient_type).toBe('role');
        expect(r.recipient_id).toBe(sanitize(assignee, 40));
        expect(r.severity).toBe('high');
        expect(r.status).toBe('pending');
      }
      // 契约声明的表 ↔ 本例真实查询对象必须一致（否则"从契约重算"其实指的是另一张表）
      expect(contract.projection_table).toBe('ewoh_notification');
      expect(contract.authority_table).toBe('ewoh_event');
      // 两半同块：每条提醒都要指得回一条 AndonRaised 主事实行——派生→权威的指向性，
      // 拿 external_ref 写错的那一行做对照就会红（不是恒真对账）。
      const linked = await owner.unsafe<Array<{ n: string }>>(
        `select count(*)::text as n
           from public.ewoh_notification n
          where n.notification_id like $1
            and exists (select 1 from public.ewoh_event e
                         where e.event_id = n.external_ref and e.event_type = 'AndonRaised')`,
        [`NTF-ANDON-${sanitize(eventId, 80)}-%`],
      );
      expect(got.length).toBeGreaterThan(0);
      expect(String(linked[0]?.n)).toBe(String(got.length));
    });

    it('AND-03 重开序号等式：第二次重开必须落 reopened-2（不恒为 reopened）', async () => {
      if (!config) return;
      for (let i = 1; i <= 2; i += 1) {
        await closeOut(eventId, tokens.handler);
        const reopened = await action(`/api/oee/andons/${eventId}/state?action=reopen`, tokens.admin);
        expect([200, 201]).toContain(reopened.status);
        expect(reopened.body?.status).toBe('reopened');
        const k = await reopenCount(eventId);
        expect(k).toBe(i);
        const bucketOf = (n: number) => (n >= 2 ? `reopened-${n}` : 'reopened');
        const bucket = bucketOf(k);
        // 提醒行是**累加**的：每次重开落自己那一桶，旧桶的行不删（关灯只把它们标成已处置）。
        // 期望集合因此＝raised ＋ 第 1..k 次重开各自的重算集合。
        const want = sorted([
          ...expectedIds(contract, eventId, 'raised', { assignee, severity: 'high' }),
          ...Array.from({ length: k }, (_, idx) => idx + 1).flatMap((n) =>
            expectedIds(contract, eventId, bucketOf(n), { assignee, severity: 'high' })),
        ]);
        const got = sorted((await rows(eventId)).map((r) => r.notification_id));
        expect(got).toEqual(want);
        // reopened 腿比 raised 腿多一个班组长（契约里两条 recipient 规则不同 ⇒ 这条断言只在契约说了的时候成立）
        expect(got.some((id) => id.includes(`-${bucket}-role-workshop_lead-`))).toBe(true);
      }
    });

    it('AND-04 幂等：reopened 态再发 reopen 被拒 ⇒ 行数与 id 集合一字不动', async () => {
      if (!config) return;
      // 本例的前提：此刻这条安灯确实处在 reopened 态（AND-03 刚重开过）。
      // 没有这一句，"reopen 被拒"可能只是因为它发生在 open 态——那证的是另一件事。
      expect(await statusOf(eventId)).toBe('reopened');
      const before = sorted((await rows(eventId)).map((r) => r.notification_id));
      const again = await action(`/api/oee/andons/${eventId}/state?action=reopen`, tokens.admin);
      expect(again.status).toBeGreaterThanOrEqual(400);
      const after = sorted((await rows(eventId)).map((r) => r.notification_id));
      expect(after).toEqual(before);
    });

    it('AND-05 了结：关灯把该安灯全部桶的提醒一并了结，重开不复活旧行', async () => {
      if (!config) return;
      await closeOut(eventId, tokens.handler);
      const all = await rows(eventId);
      expect(all.length).toBeGreaterThan(0);
      for (const r of all) {
        expect(r.resolution).toBe('andon_cleared');
        expect(r.resolved_at).not.toBeNull();
      }
      const before = sorted(all.map((r) => r.notification_id));
      const reopened = await action(`/api/oee/andons/${eventId}/state?action=reopen`, tokens.admin);
      expect([200, 201]).toContain(reopened.status);
      const after = await rows(eventId);
      const added = sorted(after.map((r) => r.notification_id)).filter((id) => !before.includes(id));
      const k = await reopenCount(eventId);
      expect(added).toEqual(
        sorted(expectedIds(contract, eventId, k >= 2 ? `reopened-${k}` : 'reopened', { assignee, severity: 'high' })),
      );
      // 旧行没被复活：全部桶里除新增那一组，resolution 仍是 andon_cleared
      for (const r of after.filter((x) => !added.includes(x.notification_id))) {
        expect(r.resolution).toBe('andon_cleared');
      }
    });
  },
);
