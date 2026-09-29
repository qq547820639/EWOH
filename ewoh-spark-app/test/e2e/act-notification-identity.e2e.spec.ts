/**
 * 改进行动"逾期"提醒的身份到底等不等？（V276：NOTIFICATION_FANOUT 格的行动项腿契约派生等式）
 *
 * 问法：`ewoh_notification` 里 `NTF-ACT-…` 这批行是**派生投影**（由 `ewoh_improvement_action` 里
 * 已接受且期限已过的行动项 + 收件人规则 + 渠道开关算出）。口径此前只在
 * `shared/improvement-action-notification.ts` 与 `improvement-action.service.ts:313-320`，
 * "改了收件人或 severity 分岔会不会红"在真实库上没有落点。本轮把口径提进
 * `contracts/state-machines/alert.yaml` 的 `action_notification_identity`，本文件从契约自己拼期望集合再比。
 *
 * **这一支同时改判 V271 的族表读数**：V271 把 ACT 的 `action_overdue` 归进"挂在 now 上、事后不可重算"一族。
 * 实测不成立——逾期谓词是 `due_at < 扫描时刻`，**单调**（一旦过期不会反转），所以 `due_at` 落库后
 * "该不该发"可事后重算；真正不可重算的只有负责人账号那半（要按当下有效用户反查）。
 * 前提因此不是"owner 为空"：`chk_ewoh_improvement_action_accepted`（standalone_088）让
 * accepted 必带 owner，库里写不出空负责人的行动项 ⇒ 可达前提是**负责人存在但没有可用账号绑定**。
 *
 * 既有覆盖（按断言语义搜过 `NTF-ACT`／桶名／`overdue-sweep`，不是按登记位点查）：
 *  - `test/e2e/improvement-action-loop.mjs` 走过逾期扫描与完成处置，但那是**脚本层**且不在 CHAIN_SPECS 里；
 *  - 服务侧单测用 mock db，钉的是"调了 insert"而不是真实唯一键上的行集合；
 *  - 没有任何 `*.e2e.spec.ts` 读过 `NTF-ACT-` 前缀下的行。
 *
 * 五支断言：
 *  - AC-01 前提：负责人无可用账号 ⇒ 扫描把这行动项算进逾期、`unresolvedOwners` 里登记**剥掉 `person:` 前缀的规范引用**、
 *          `notified` 里的收件人逐项等于契约的角色名（响应给的是裸 recipientId，不带 `role:` 前缀）；
 *  - AC-02 等式（priority=medium）：行集合＝契约 recipients × 渠道，severity 列＝契约算出的 `medium`；
 *  - AC-03 等式（priority=high）：同一套收件人，severity 列＝`high`——这条才是"severity 真的按 priority 分岔"的证据；
 *  - AC-04 幂等＋无幽灵：再扫一次集合一字不动；一条 `due_at` 在未来的行动项前缀下 0 行；
 *  - AC-05 同事务处置：`POST :actionId/complete` 之后，提醒行按前缀带上 `resolution='action_completed'`
 *         **且**权威行 status 已是 `completed`（两算：投影与主事实同时到位才叫"事办完、提醒了结"）。
 *
 * 限度：等式只覆盖角色半与 id/severity 形状；正文里的"已逾期 N 天"随扫描时刻变，不进等式（契约 not_recomputable 已写明）。
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
import { normalizePersonRef } from '@shared/identity';

const config = resolveE2EConfig();
const CONTRACT_PATH = resolve(__dirname, '../../../contracts/state-machines/alert.yaml');

interface SeverityRule { priority_high: string; otherwise: string }
interface IdentityContract {
  projection_table: string;
  authority_table: string;
  prefix_shape: string;
  id_shape: string;
  id_slice_chars: number;
  external_ref: string;
  buckets: Record<'action_overdue', {
    recipients: Array<{ type: string; id: string }>;
    severity_column: SeverityRule;
  }>;
  channels: Array<{ name: string; enabled_when: string }>;
}

function identity(): IdentityContract {
  const doc = load(readFileSync(CONTRACT_PATH, 'utf8')) as { action_notification_identity?: IdentityContract };
  const c = doc.action_notification_identity;
  if (!c || !c.prefix_shape || !c.id_shape || !c.buckets?.action_overdue?.recipients?.length
    || !c.buckets.action_overdue.severity_column || !Array.isArray(c.channels)) {
    throw new Error('[AC] 契约 alert.yaml 里读不到 action_notification_identity ⇒ 期望集合无从重算（判不可用=抛，不静默跳过）');
  }
  return c;
}

/** 渠道启用：逐条按契约写的 env 谓词自己判，不调实现里的开关函数。 */
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
    throw new Error(`[AC] 契约里出现本例不认识的 enabled_when：${ch.enabled_when}`);
  }).map((ch) => ch.name);
}

const sanitize = (v: string, max: number) => String(v ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);

function expectedIds(c: IdentityContract, actionId: string): string[] {
  const prefix = `NTF-ACT-${sanitize(actionId, 80)}-`;
  return c.buckets.action_overdue.recipients.flatMap((r) => channelsFromContract(c).map((ch) => {
    const raw = `${prefix}action_overdue-${sanitize(r.type, 40)}-${sanitize(r.id, 40)}-${ch}`;
    return raw.slice(0, c.id_slice_chars);
  }));
}

function severityOf(c: IdentityContract, priority: string | null): string {
  return String(priority ?? '').trim().toLowerCase() === 'high'
    ? c.buckets.action_overdue.severity_column.priority_high
    : c.buckets.action_overdue.severity_column.otherwise;
}

interface NotifRow { notification_id: string; external_ref: string | null; severity: string | null; resolution: string | null }
interface ActionRow { action_id: string; status: string; priority: string | null; due_at: string | null; owner: string | null }

(config ? describe : describe.skip)(
  '改进行动逾期提醒身份 E2E（真实 PostgreSQL，角色半的契约派生等式）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let leadToken: string;
    const runId = randomUUID().slice(0, 8);

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });

    beforeEach(async () => {
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const lead = await login(handle.baseUrl, fixture.approverA.username, fixture.approverA.password);
      expect(lead.status).toBe(201);
      leadToken = lead.body.accessToken;
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

    /** 负责人存在但**没有可用账号绑定** ⇒ 实现记进 unresolvedOwners 且不产出 user 收件人（等式只覆盖角色半的前提）。 */
    const unboundOwner = () => `person:e2e-unbound-${runId}`;

    /**
     * 造一条"已接受＋期限已过（或在将来）"的行动项：前提注入走 owner 直写，提醒的产生仍是被测服务。
     * `chk_ewoh_improvement_action_accepted`（standalone_088）要求 accepted 必带 owner／due_at／
     * acceptance_criteria／accepted_by／accepted_at ⇒ 库里写不出"无负责人的 accepted 行动项"。
     *
     * 库内 check 比记录契约**松**：`chk_ewoh_improvement_action_evidence` 只管"jsonb 数组且 ≥1 项"，
     * 而 `shared/improvement-action.ts:115-120` 的 `ImprovementEvidenceRef` 要每项带非空 `id`，
     * 这条要到 `complete()` 里的 `validateImprovementAction`（service:458）才拦 ⇒
     * 直写seed 若漏 `id`，插入会成功、完成会 400（本轮实测过）。jsonb 参数一律用 `owner.json(...)`：
     * postgres.js 会把 `JSON.stringify` 出来的**字符串**再编码一次，落库成 `jsonb_typeof='string'` 的标量
     * （探针读数：cast／plain 两种写法都是 string，只有传 JS 数组／对象才是 array／object）。
     */
    async function seedAction(tag: string, priority: string, dueInMs: number): Promise<ActionRow> {
      const actionId = `ACT-AC-ID-${tag}-${runId}`;
      const due = new Date(Date.now() + dueInMs);
      await owner`
        insert into public.ewoh_improvement_action
          (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
           evidence_json, owner, due_at, acceptance_criteria, accepted_by, accepted_at, detected_at, record_json)
        values (${fixture.orgA.id}, ${actionId}, 'retrospective_lesson', ${`lrn-${tag}-${runId}`},
                ${`V276 身份等式 ${tag}`}, '一次性试点常驻用例造的逾期行动项', 'process_change', ${priority}, 'accepted',
                ${owner.json([{ type: 'lesson', id: `lrn-${tag}-${runId}`, at: null }])}, ${unboundOwner()}, ${due.toISOString()}, '按判据完成并填结果说明',
                ${fixture.approverA.username}, ${new Date().toISOString()}, ${new Date().toISOString()},
                ${owner.json({ action_id: actionId })})`;
      // 身份、优先级、期限一律**回读**：期望集合不许拿用例自己写的字面量比自己写的字面量。
      const [row] = await owner<ActionRow[]>`
        select action_id, status, priority, due_at, owner from public.ewoh_improvement_action
        where action_id = ${actionId}`;
      expect(row).toBeTruthy();
      return row!;
    }

    /** 响应键名按服务侧真实形状写（`notified` 是数组，不是计数）：读 JSON 前先验键名。 */
    const sweep = () => apiRequest<{
      scanned: number; created: number; duplicates: number;
      unresolvedOwners: string[];
      notified: Array<{ actionId: string; recipients: string[] }>;
    }>(handle.baseUrl, '/api/learning/actions/overdue-sweep', {
      method: 'POST', headers: jsonHeaders(leadToken), body: '{}',
    });

    async function notifRows(actionId: string): Promise<NotifRow[]> {
      const prefix = `NTF-ACT-${sanitize(actionId, 80)}-`;
      return await owner<NotifRow[]>`
        select notification_id, external_ref, severity, resolution from public.ewoh_notification
        where notification_id like ${prefix + '%'} order by notification_id`;
    }

    function expectSetEquals(rows: NotifRow[], want: string[]) {
      const got = rows.map((r) => String(r.notification_id)).sort();
      expect(got.length).toBe(want.length);
      expect(got).toEqual([...want].sort());
    }

    it('AC-01 前提：负责人未绑定账号 ⇒ 该行动项被算进逾期、如实进 unresolvedOwners、收件人清一色是角色', async () => {
      const c = identity();
      const roleIds = c.buckets.action_overdue.recipients.filter((r) => r.type === 'role').map((r) => r.id);
      const action = await seedAction('premise', 'medium', -2 * 86_400_000);
      expect(String(action.owner ?? '')).not.toBe('');   // accepted 必带负责人（库内 check）
      expect(action.status).toBe('accepted');

      const swept = await sweep();
      expect(swept.status).toBe(201);
      expect(Number(swept.body.scanned ?? 0)).toBeGreaterThanOrEqual(1);
      // 负责人没有可用账号 ⇒ 如实进 unresolvedOwners（"没叫到人"必须看得见）。
      // 登记的键是**剥掉 `person:` 前缀后的规范引用**（normalizePersonRef），不是列里的原字符串。
      expect((swept.body.unresolvedOwners ?? []).map(String))
        .toContain(String(normalizePersonRef(String(action.owner ?? ''))));
      const mine = swept.body.notified.filter((n) => n.actionId === action.action_id);
      expect(mine.length).toBeGreaterThan(0);
      // 响应里的 recipients 是裸 recipientId（不带 `role:` 前缀），所以与契约的角色名逐项相等：
      // 这一条同时钉住"账号缺口只补角色、不猜用户"。
      expect([...new Set(mine.flatMap((n) => n.recipients))].sort()).toEqual([...roleIds].sort());
    });

    it('AC-02 等式（priority=medium）：落库行集合＝契约 recipients × 渠道，severity 列＝契约算出的值', async () => {
      const c = identity();
      const action = await seedAction('med', 'medium', -3 * 86_400_000);
      expect((await sweep()).status).toBe(201);

      const rows = await owner<NotifRow[]>`
        select notification_id, external_ref, severity, resolution from public.ewoh_notification
        where notification_id like ${`NTF-ACT-${sanitize(action.action_id, 80)}-%`} order by notification_id`;
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, expectedIds(c, action.action_id));
      for (const row of rows) {
        expect(String(row.external_ref)).toBe(action.action_id);
        expect(String(row.severity)).toBe(severityOf(c, action.priority));
      }
      const [exists] = await owner`
        select 1 as hit from public.ewoh_improvement_action a
        where a.action_id = ${action.action_id} and a.status = 'accepted' and a.due_at < now()`;
      expect(exists).toBeTruthy();
    });

    it('AC-03 等式（priority=high）：severity 真的按 priority 分岔，否则本支会与 medium 那支读成同一个值', async () => {
      const c = identity();
      const action = await seedAction('high', 'high', -5 * 86_400_000);
      expect((await sweep()).status).toBe(201);

      const rows = await notifRows(action.action_id);
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, expectedIds(c, action.action_id));
      for (const row of rows) expect(String(row.severity)).toBe(severityOf(c, action.priority));
      // 分岔本身也要断：两档算出的值不等，否则 severity_column 被读成常量也不会红
      expect(severityOf(c, 'high')).not.toBe(severityOf(c, 'medium'));
    });

    it('AC-04 幂等＋无幽灵：再扫一次集合一字不动；期限还没到的行动项前缀下 0 行', async () => {
      const future = await seedAction('future', 'medium', 3 * 86_400_000);
      const action = await seedAction('idem', 'medium', -86_400_000);
      expect((await sweep()).status).toBe(201);
      const before = await notifRows(action.action_id);
      expect(before.length).toBeGreaterThan(0);

      expect((await sweep()).status).toBe(201);
      const after = await notifRows(action.action_id);
      expect(after.map((r) => String(r.notification_id)).sort())
        .toEqual(before.map((r) => String(r.notification_id)).sort());
      expect(after.length).toBe(before.length);
      // 无幽灵对照：未到期 ⇒ 一行都不该有
      expect(await notifRows(future.action_id)).toEqual([]);
    });

    it('AC-05 同事务处置：complete 之后提醒带 action_completed 且权威行已 completed，再扫不新增', async () => {
      const c = identity();
      const action = await seedAction('done', 'medium', -4 * 86_400_000);
      expect((await sweep()).status).toBe(201);
      const issued = await notifRows(action.action_id);
      expectSetEquals(issued, expectedIds(c, action.action_id));

      const done = await apiRequest(handle.baseUrl, `/api/learning/actions/${action.action_id}/complete`, {
        method: 'POST',
        headers: jsonHeaders(leadToken),
        body: JSON.stringify({ outcomeNote: 'V276 身份等式：已按判据完成' }),
      });
      expect(done.status).toBeLessThan(400);

      const rows = await notifRows(action.action_id);
      expect(rows.length).toBe(issued.length);
      for (const row of rows) expect(String(row.resolution)).toBe('action_completed');
      const [after] = await owner`select status from public.ewoh_improvement_action where action_id = ${action.action_id}`;
      expect(String(after.status)).toBe('completed');

      expect((await sweep()).status).toBe(201);
      expect((await notifRows(action.action_id)).map((r) => String(r.notification_id)).sort())
        .toEqual(rows.map((r) => String(r.notification_id)).sort());
    });
  },
);
