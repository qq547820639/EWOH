/**
 * 数据质量提醒的身份到底等不等？（V274：NOTIFICATION_FANOUT 格的数据质量腿契约派生等式）
 *
 * 问法：`ewoh_notification` 里 `NTF-DQ-…` 这批行是**派生投影**（由 `ewoh_event` 里 open 的
 * `DataQualityAlert` + 严重度→角色规则 + 渠道开关算出）。口径此前只在
 * `shared/data-quality-notification.ts` 与 `data-quality-notification.service.ts` 里，
 * "改了角色清单或 aging 桶名会不会红"在真实库上没有集合级落点。本轮把口径提进
 * `contracts/state-machines/alert.yaml` 的 `data_quality_notification_identity`，本文件
 * **从契约自己拼期望集合**（前缀形状、role_rule、severity_column、渠道 enabled_when、截断长度），
 * 再与落库行做集合相等比较；severity 与 event_id 都**回读库里的行**，不拿自己写的字面量比自己。
 *
 * 既有覆盖到底钉到哪一层（按断言语义搜过，不是按登记位点查）：
 *  - `test/unit/data-quality/data-quality-notification.service.spec.ts:127／:213`——**mock db**，
 *    且只断 `startsWith('NTF-DQ-EVT-DQ-1-quality_alert-')`（前缀），不是集合相等；
 *  - `test/e2e/data-quality-notification-leg.mjs:207-216`——真实库读 `ewoh_notification`，
 *    但只断"存在一条 role:workshop_lead 且前缀对"与 aging `>=1`；**该脚本不在每遍重放的场景清单里**
 *    （`scripts/chain-baseline/verify.sh` 里没有它的引用）⇒ 它既是更弱的一层，也不在门禁面上；
 *  - `server/modules/learning/learning-signal.service.ts:421` 真读 `NTF-DQ-%` 前缀（消费侧），
 *    但消费侧读的是"有没有"，不是"该有的是不是就是这些"。
 *  ⇒ 缺的是"角色半在真实唯一键上的集合等式"，本文件补这一格。
 *
 * 六支断言：
 *  - DQ-01 前提：该设备在 `ewoh_device_responsibility` 里 0 行 ⇒ 扫描响应里 user 收件人相关数组全空、
 *          `notifyRequired>=1`（前提不成立时等式会静默少一半，必须先钉）；
 *  - DQ-02 等式（摄入侧同款严重度 L2）：行集合＝契约 `role_rule.otherwise` × 渠道，且 severity 列＝契约算出的 `medium`；
 *  - DQ-03 等式（critical）：行集合＝契约 `role_rule.critical_or_high` 两条角色 × 渠道，severity 列＝`high`
 *          ——这一支才是"角色规则真的按严重度分岔"的证据（只有 L2 的话等式可以在漏掉分岔时也成立）；
 *  - DQ-04 aging 等式：把 `created_at` 钉在 25h 前（阈值 24h，留 1h 余量）⇒ 期望＝两桶并集；
 *  - DQ-05 幂等：同一状态再扫一次 ⇒ 行数与 id 集合一字不动（重复只累加 duplicates）；
 *  - DQ-06 无幽灵＋了结：一条**扫描之前就已了结**（status 非 open）的告警前缀下 0 行；
 *          而 confirm 已发过提醒的那条，其提醒行按契约带上 resolution，再扫一次不新增也不删除。
 *
 * 限度（引用这一格之前要一起说）：等式只覆盖**角色半**。设备责任人那半要过
 * `resolveCurrentShiftId(orgId, new Date())`（班次随时刻翻档）⇒ 契约列在 `not_recomputable`，
 * 本文件不硬写那半。`requiresHumanVerification` 今天恒真 ⇒ 不写成契约字段（写了就是第二条真值源）。
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
const AGING_MS = 24 * 60 * 60 * 1000;

interface SeverityRule { critical_or_high: string; otherwise: string }
interface IdentityContract {
  projection_table: string;
  authority_table: string;
  prefix_shape: string;
  id_shape: string;
  id_slice_chars: number;
  external_ref: string;
  role_rule: { critical_or_high: string[]; otherwise: string[] };
  buckets: Record<'quality_alert' | 'quality_aging', { severity_column: SeverityRule }>;
  channels: Array<{ name: string; enabled_when: string }>;
}

function identity(): IdentityContract {
  const doc = load(readFileSync(CONTRACT_PATH, 'utf8')) as {
    data_quality_notification_identity?: IdentityContract;
  };
  const c = doc.data_quality_notification_identity;
  if (!c || !c.prefix_shape || !c.id_shape || !c.role_rule?.critical_or_high || !c.role_rule?.otherwise
    || !c.buckets?.quality_alert?.severity_column || !c.buckets?.quality_aging?.severity_column
    || !Array.isArray(c.channels)) {
    throw new Error('[DQ] 契约 alert.yaml 里读不到 data_quality_notification_identity ⇒ 期望集合无从重算（判不可用=抛，不静默跳过）');
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
    throw new Error(`[DQ] 契约里出现本例不认识的 enabled_when：${ch.enabled_when}`);
  }).map((ch) => ch.name);
}

const sanitize = (v: string, max: number) => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max);

/** 契约的角色半：严重度取自**库里的行**，不是用例传的参数。 */
function rolesFor(c: IdentityContract, severity: string | null): string[] {
  const key = String(severity ?? '').trim().toLowerCase();
  return key === 'critical' || key === 'high' ? c.role_rule.critical_or_high : c.role_rule.otherwise;
}
function severityColumn(c: IdentityContract, severity: string | null): string {
  const key = String(severity ?? '').trim().toLowerCase();
  return key === 'critical' || key === 'high'
    ? c.buckets.quality_alert.severity_column.critical_or_high
    : c.buckets.quality_alert.severity_column.otherwise;
}
/** 期望 id：桶 × 角色 × 渠道，按契约形状与截断长度拼出来。 */
function expectedIds(c: IdentityContract, eventId: string, severity: string | null, buckets: string[]): string[] {
  const prefix = `NTF-DQ-${sanitize(eventId, 80)}-`;
  const channels = channelsFromContract(c);
  return buckets.flatMap((bucket) => rolesFor(c, severity).flatMap((role) => channels.map((ch) => {
    const raw = `${prefix}${bucket}-role-${sanitize(role, 40)}-${ch}`;
    return raw.slice(0, c.id_slice_chars);
  })));
}

interface AlertRow { event_id: string; severity: string | null; status: string; org_id: string }
interface NotifRow { notification_id: string; external_ref: string | null; severity: string | null; resolution: string | null }

(config ? describe : describe.skip)(
  '数据质量提醒身份 E2E（真实 PostgreSQL，角色半的契约派生等式）',
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
      // gap-sweep 的 @Roles 收在 workshop_lead／safety_admin／global_admin；用班组长账号走真实权限面。
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

    /** 造一条 open 的 DataQualityAlert（前提注入走 owner 直写；提醒的**产生**仍是被测服务）。 */
    async function seedAlert(tag: string, severity: string, ageMs: number): Promise<AlertRow> {
      const eventId = `EVT-DQ-ID-${tag}-${runId}`;
      const deviceId = `EXO-DQ-ID-${tag}-${runId}`;
      const at = new Date(Date.now() - ageMs);
      await owner`
        insert into public.ewoh_event
          (event_id, org_id, device_id, event_code, event_type, severity, title, status, source_type,
           evidence_json, created_at, occurred_at, received_at, observed_at, schema_version)
        values (${eventId}, ${fixture.orgA.id}, ${deviceId}, 'CLOCK_DRIFT', 'DataQualityAlert', ${severity},
                ${`V274 身份等式 ${tag}`}, 'open', 'real',
                ${owner.json({ device_id: deviceId, fired_at: at.toISOString() })},
                ${at}, ${at}, ${at}, ${at}, '1.0.0')`;
      // 身份与严重度一律**回读**：期望集合不许拿用例自己写的字面量去比自己写的字面量。
      const [row] = await owner<AlertRow[]>`
        select event_id, severity, status, org_id from public.ewoh_event where event_id = ${eventId}`;
      expect(row).toBeTruthy();
      /**
       * 前提形状也要回读（V277）：jsonb 列拿到的是对象而不是字符串标量。
       * postgres.js 会把"长得像 JSON 的字符串参数"再编码一次 ⇒ `${JSON.stringify({...})}` 落库成
       * `jsonb_typeof='string'`，实现侧 `evidence.fired_at` 就永远读不到 ⇒ 提醒正文里的触发时间写成"未记录"，
       * 而这条用例的 id 等式照绿——即"payload 半边从没喂给实现"。等式不依赖正文，但前提依赖形状。
       */
      const [shape] = await owner<{ t: string; fired: string | null }[]>`
        select jsonb_typeof(evidence_json) as t, (evidence_json ->> 'fired_at') as fired
        from public.ewoh_event where event_id = ${eventId}`;
      expect(String(shape!.t)).toBe('object');
      expect(String(shape!.fired)).toBe(at.toISOString());
      return row!;
    }

    const sweep = () => apiRequest<{
      scanned: number; notifyRequired: number; created: number; duplicates: number; agingNudged: number;
      unresolvedResponsiblePersons: string[]; outOfShiftResponsiblePersons: string[];
      notifications: Array<{ alertEventId: string; bucket: string; recipients: string[] }>;
    }>(handle.baseUrl, '/api/data-quality/gap-sweep', { method: 'POST', headers: jsonHeaders(leadToken), body: '{}' });

    async function notifRows(eventId: string): Promise<NotifRow[]> {
      const prefix = `NTF-DQ-${sanitize(eventId, 80)}-`;
      return await owner<NotifRow[]>`
        select notification_id, external_ref, severity, resolution from public.ewoh_notification
        where notification_id like ${prefix + '%'} order by notification_id`;
    }

    function expectSetEquals(rows: NotifRow[], want: string[]) {
      const got = rows.map((r) => String(r.notification_id)).sort();
      expect(got.length).toBe(want.length);
      expect(got).toEqual([...want].sort());
    }

    it('DQ-01 前提：该设备无任何责任关系 ⇒ 扫描只叫角色、user 半确实为空', async () => {
      const alert = await seedAlert('premise', 'L2', 60_000);
      const [resp] = await owner`select 1 as hit from public.ewoh_device_responsibility
        where org_id = ${alert.org_id} and device_id = ${'EXO-DQ-ID-premise-' + runId} and active = true`;
      expect(resp).toBeUndefined();

      const swept = await sweep();
      expect(swept.status).toBe(201);
      expect(swept.body.notifyRequired).toBeGreaterThanOrEqual(1);
      expect(swept.body.unresolvedResponsiblePersons).toEqual([]);
      expect(swept.body.outOfShiftResponsiblePersons).toEqual([]);
      const forThis = (swept.body.notifications ?? []).filter((n) => n.alertEventId === alert.event_id);
      expect(forThis.length).toBeGreaterThan(0);
      expect(forThis.every((n) => n.recipients.every((r) => r.startsWith('role:')))).toBe(true);
    });

    it('DQ-02 等式（摄入侧同款严重度 L2）：行集合＝契约 otherwise 角色 × 渠道，severity 列＝契约算出的值', async () => {
      const c = identity();
      const alert = await seedAlert('l2', 'L2', 60_000);
      expect((await sweep()).status).toBe(201);

      // 投影侧读取写在**块内字面**：helper 里的表名对本格判据不可见，两算要在同一块里读到两边
      const rows = await owner<NotifRow[]>`
        select notification_id, external_ref, severity, resolution from public.ewoh_notification
        where notification_id like ${`NTF-DQ-${sanitize(alert.event_id, 80)}-%`} order by notification_id`;
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, expectedIds(c, alert.event_id, alert.severity, ['quality_alert']));
      for (const row of rows) {
        expect(String(row.external_ref)).toBe(alert.event_id);
        expect(String(row.severity)).toBe(severityColumn(c, alert.severity));
      }
      const [exists] = await owner`
        select 1 as hit from public.ewoh_event e
        where e.event_id = ${alert.event_id} and e.event_type = 'DataQualityAlert' and e.status = 'open'`;
      expect(exists).toBeTruthy();
    });

    it('DQ-03 等式（critical）：角色分岔真的按严重度走，否则这一支会与 L2 那支塌成同一份集合', async () => {
      const c = identity();
      const alert = await seedAlert('crit', 'critical', 60_000);
      expect((await sweep()).status).toBe(201);

      const rows = await notifRows(alert.event_id);
      const want = expectedIds(c, alert.event_id, alert.severity, ['quality_alert']);
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, want);
      // 分岔本身也要断：critical 的清单必须比 otherwise 多一条（少写这条，role_rule 被读成常量也不会红）
      expect(c.role_rule.critical_or_high.length).toBeGreaterThan(c.role_rule.otherwise.length);
      for (const row of rows) expect(String(row.severity)).toBe(severityColumn(c, alert.severity));
    });

    it('DQ-04 aging 等式：created_at 钉在 25h 前 ⇒ 期望是两桶并集（阈值由契约的 when 与常量算出，不靠 now）', async () => {
      const c = identity();
      const alert = await seedAlert('aging', 'L2', AGING_MS + 3_600_000);
      const swept = await sweep();
      expect(swept.body.agingNudged).toBeGreaterThanOrEqual(1);

      const rows = await notifRows(alert.event_id);
      expect(rows.length).toBeGreaterThan(0);
      expectSetEquals(rows, expectedIds(c, alert.event_id, alert.severity, ['quality_alert', 'quality_aging']));
      expect(rows.some((r) => /-quality_aging-role-/.test(String(r.notification_id)))).toBe(true);
    });

    it('DQ-05 幂等：同一状态再扫一次 ⇒ 行数与 id 集合一字不动（重复只累加 duplicates）', async () => {
      const alert = await seedAlert('idem', 'critical', AGING_MS + 3_600_000);
      const first = await sweep();
      expect(first.status).toBe(201);
      const before = await notifRows(alert.event_id);
      expect(before.length).toBeGreaterThan(0);

      const second = await sweep();
      expect(second.status).toBe(201);
      // TESTITLE-01（V328 补的牙）：标题那句「重复只累加 duplicates」过去只是**没被读**，
      // 这一格把它变成判据。取**两遍之差**而不是绝对值——整单扫描的计数里混着别的告警的行，
      // 只有差值能归因到"我这行第一遍建、第二遍撞上已有行"；`created` 那一支走 ON CONFLICT
      // DO NOTHING 的另一侧，所以它不涨而 duplicates 必须涨。
      expect(Number(second.body.duplicates) - Number(first.body.duplicates)).toBeGreaterThanOrEqual(1);
      const after = await notifRows(alert.event_id);
      expect(after.map((r) => String(r.notification_id)).sort())
        .toEqual(before.map((r) => String(r.notification_id)).sort());
      expect(after.length).toBe(before.length);
    });

    it('DQ-06 无幽灵＋了结：扫描前就已了结的告警不得有行；confirm 之后提醒带 resolution 且再扫不新增', async () => {
      const c = identity();
      // 甲：扫描之前就 closed ⇒ 永远不该有提醒行
      const ghost = await seedAlert('ghost', 'L2', 60_000);
      await owner`update public.ewoh_event set status = 'resolved' where event_id = ${ghost.event_id}`;
      // 乙：open，正常发出提醒后被人工判定
      const alert = await seedAlert('done', 'L2', 60_000);
      expect((await sweep()).status).toBe(201);
      expect(await notifRows(ghost.event_id)).toEqual([]);
      const issued = await notifRows(alert.event_id);
      expectSetEquals(issued, expectedIds(c, alert.event_id, alert.severity, ['quality_alert']));

      const confirmed = await apiRequest(handle.baseUrl, '/api/data-quality/confirmations', {
        method: 'POST',
        headers: jsonHeaders(leadToken),
        body: JSON.stringify({ eventId: alert.event_id, verdict: 'confirmed', note: 'V274 身份等式' }),
      });
      expect(confirmed.status).toBeLessThan(400);
      const resolved = await notifRows(alert.event_id);
      expect(resolved.length).toBe(issued.length);
      for (const row of resolved) {
        expect(String(row.resolution)).toBe('data_quality_confirmed');
      }
      // 再扫一次：告警已非 open ⇒ 该前缀下行数不动（了结不删行，也不复活）
      expect((await sweep()).status).toBe(201);
      expect((await notifRows(alert.event_id)).map((r) => String(r.notification_id)).sort())
        .toEqual(resolved.map((r) => String(r.notification_id)).sort());
    });
  },
);
