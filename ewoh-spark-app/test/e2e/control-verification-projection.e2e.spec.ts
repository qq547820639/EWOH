/**
 * EDGE-03 的代价侧（V95）：网关"本机验签结论"与运维读面 `fingerprintVerified` 是不是同一件事
 * （真实 Nest + 真实 PostgreSQL）。
 *
 * 背景：本机没配指纹密钥时，网关**如实上报** `fingerprintVerified=false` +
 * `fingerprintNote=fingerprint_secret_missing`（fail-open 姿态，仓库自己的既有测试
 * `test_missing_local_secret_is_reported_not_faked` 钉住了"不假装验过"）。
 * 而运维侧"执行边界"面板显示的 `fingerprintVerified` 来自
 * `Boolean(row.authorizationVerifiedAt)`（`control.service.ts:1855`）——
 * 那是**平台侧授权复核**的时间戳（投递 CAS 写的，`control.service.ts:2551`），不是网关验签结论。
 *
 * 本文件把这句话从"读码"推到"实测"，两条互为对照：
 *  VP-01 网关上报"未验签（缺密钥）"的命令行里，JSON 存的是 false，而读面报 true；
 *  VP-02 判别对照：另一条命令网关上报"已验签 true" ⇒ 读面取值与 VP-01 **完全相同**
 *       ⇒ 证明该字段不携带任何网关信息（不是"偶尔读错"，而是口径不同源）。
 * 两例都标"现状钉住"：一旦读面改为取网关结论（或把两者拆成两个字段），
 * VP-01/VP-02 的断言会各自变红，届时按新口径重写，不要顺手删。
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

type Boundary = {
  commands?: Array<{
    commandId?: string;
    fingerprintScheme?: string;
    fingerprintVerified?: boolean;
    ack?: { delivered?: boolean; reason?: string | null } | null;
  }>;
};

(config ? describe : describe.skip)(
  '网关验签结论与运维读面口径 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let adminToken = '';
    let baseUrl = '';
    const runId = randomUUID().slice(0, 8);
    const deviceId = `AGV-V95-${runId}`;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      baseUrl = handle.baseUrl;
      const admin = await login(baseUrl, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
    });

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });
    /**
     * DL-01（V235·PROJ-09 前半）设备台账 vs 遥测：不变量是「该列最近一个**非空**帧」，不是「最新一帧」。
     * 依据：ingest 的冲突更新对缺字段的帧故意不改台账（`ingest.service.ts:347` 一带
     * `coalesce(excluded.battery_pct, ewoh_device.battery_pct)`，注释自陈否则一批不带电量的帧
     * 会把已知电量擦成 NULL，而 candidate-engine 对未知电量给无穷能耗罚 ⇒ 设备凭空失去派工资格），
     * 而同一帧仍原样写进 `ewoh_telemetry`。两帧夹具正是为了让「跟最新帧」与「跟最近非空帧」两种写法可判别。
     */
    it('DL-01 台账列＝该列最近一个非空帧（DEVICE_LEDGER 常驻对账，含开火对照）', async () => {
      const dlDevice = `EXO-DL01-${runId}`;
      // 接入闸门（实测：不带这行时两帧都以 accepted:false 被拒，台账与遥测一行都不写）：
      // 单帧路径先查 ewoh_spatial_entity 的 (org_id, entity_id)，查不到就 fail-closed 拒绝写入。
      await owner.unsafe(
        `insert into public.ewoh_spatial_entity
           (org_id, entity_id, entity_type, name, source_type)
         values ($1::uuid, $2, 'device', $2, 'seed') on conflict do nothing`,
        [fixture.orgA.id, dlDevice],
      );
      const base = Date.now();
      const postFrame = (n: number, device: Record<string, unknown>) => apiRequest<{
        accepted?: boolean;
        skipped?: boolean;
        error?: string;
        data_quality?: string;
      }>(
        baseUrl, '/api/ingest/exoskeleton', {
          method: 'POST',
          headers: { ...jsonHeaders(), 'x-ingest-key': INGEST_KEY, 'x-org-id': fixture.orgA.id },
          body: JSON.stringify({
            entity_id: dlDevice,
            device_id: dlDevice,
            // 帧号越大时间越晚，且两帧都落在接收时刻之前（未来时间戳会被坏时钟闸直接拒）。
            event_time: new Date(base - (10 - n) * 1000).toISOString(),
            source_type: 'simulated',
            pose: { trunk_pitch_deg: 30, angular_velocity_dps: 5 },
            load: { assist_level: 0.4, torque_nm: 12, cumulative_load_score: 0.5 },
            device,
            quality: { packet_loss_pct: 0, confidence: 0.9, status: 'good' },
            record_id: `dl01-${n}`,
            raw_ref: `RAW-DL01-${n}`,
          }),
        });

      // 帧一带电量＋温度；帧二不带电量、温度改值 ⇒ 两列的「最新帧」与「最近非空帧」给出不同答案。
      const r1 = await postFrame(1, { battery_pct: 77, temperature_c: 40 });
      const r2 = await postFrame(2, { temperature_c: 41 });
      // 前提：网关**接受**这两帧。状态码不算前提——单帧路径先 upsert 台账、后写遥测，
      // 写遥测失败时仍返回 2xx，只在 body 里报 accepted:false（实测教训见 §5.3ij）。
      const verdict = (r: typeof r1) => (r.body?.accepted
        ? 'ok'
        : `rejected:${r.body?.error ?? r.body?.data_quality ?? 'unknown'} skipped=${String(r.body?.skipped)}`);
      expect([verdict(r1), verdict(r2)]).toEqual(['ok', 'ok']);

      // 前提：两帧都落进遥测，且租户归属就是 x-org-id 那个租户（等式按 (org,device) 键成立的前提）。
      expect(await owner`
        select org_id, count(*)::int as n from ewoh_telemetry
         where device_id = ${dlDevice} group by org_id order by org_id`).toEqual([
        { org_id: fixture.orgA.id, n: 2 },
      ]);

      const mismatch = () => owner`
        with f as (select battery_pct, temperature_c, ts from ewoh_telemetry
                    where org_id = ${fixture.orgA.id} and device_id = ${dlDevice}),
             exp as (select (select battery_pct from f where battery_pct is not null order by ts desc limit 1) as battery,
                          (select temperature_c from f where temperature_c is not null order by ts desc limit 1) as temp),
             d as (select battery_pct, temperature_c from ewoh_device
                    where org_id = ${fixture.orgA.id} and device_id = ${dlDevice})
        select (select count(*)::int from f) as frames,
               (select count(*)::int from d) as ledger_rows,
               (select count(*)::int from d, exp
                 where not ( (d.battery_pct::numeric is not distinct from exp.battery::numeric)
                             and (d.temperature_c::numeric is not distinct from exp.temp::numeric) )) as n,
               (select d.battery_pct::text from d) as led_batt,
               (select d.temperature_c::text from d) as led_temp,
               (select exp.battery::text from exp) as exp_batt,
               (select exp.temp::text from exp) as exp_temp`;

      const first = await mismatch();
      // 前提：两帧都落了表、台账恰有一行；等式：台账每列＝该列最近一个非空帧
      //（帧二不带电量 ⇒ 电量该留在 77，温度该跟到 41）。
      expect(first[0]).toEqual({
        frames: 2, ledger_rows: 1, n: 0,
        led_batt: '77', led_temp: '41', exp_batt: '77', exp_temp: '41',
      });

      // 牙齿：手工把台账电量改错一格，同一条判据必须报不一致；改回后回到 0。
      await owner`update ewoh_device set battery_pct = 1 where org_id = ${fixture.orgA.id} and device_id = ${dlDevice}`;
      expect(Number((await mismatch())[0].n)).toBe(1);
      await owner`update ewoh_device set battery_pct = 77 where org_id = ${fixture.orgA.id} and device_id = ${dlDevice}`;
      expect(Number((await mismatch())[0].n)).toBe(0);
    }, 120_000);


    function gatewayHeaders() {
      return { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY, 'x-org-id': fixture.orgA.id };
    }

    /** 建请求 → 下发命令 → 网关轮询（= 平台投递确认，写 authorization_verified_at）。 */
    async function dispatch(tag: string): Promise<string> {
      const created = await apiRequest<{ id: string }>(baseUrl, '/api/control/requests', {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ deviceId, commandKeys: ['start'], idempotencyKey: `v95-${tag}-${runId}` }),
      });
      expect(created.status).toBe(201);
      const sent = await apiRequest<{ attempts?: { attemptId: string; commandKey: string }[] }>(
        baseUrl,
        `/api/control/requests/${created.body.id}/commands`,
        { method: 'POST', headers: jsonHeaders(adminToken), body: JSON.stringify({ commandKey: 'start', payload: {} }) },
      );
      expect(sent.status).toBe(201);
      const commandId = sent.body.attempts!.find((a) => a.commandKey === 'start')!.attemptId;
      const polled = await apiRequest<{ commands?: { commandId: string }[] }>(
        baseUrl,
        `/api/control/commands/pending?deviceId=${deviceId}&limit=50`,
        { headers: gatewayHeaders() },
      );
      expect(polled.status).toBe(200);
      expect((polled.body.commands ?? []).map((c) => c.commandId)).toContain(commandId);
      return commandId;
    }

    async function ack(commandId: string, verified: boolean, note: string) {
      const res = await apiRequest(baseUrl, `/api/control/commands/${commandId}/ack`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({
          delivered: true,
          details: {
            authorizationCheckedBeforeAction: true,
            fingerprintScheme: 'hmac-sha256:v2',
            fingerprintVerified: verified,
            fingerprintNote: note,
          },
        }),
      });
      expect([200, 201]).toContain(res.status);
    }

    /** 库里网关真正说了什么（ack 结果行的 JSON）。 */
    async function storedAckVerdict(commandId: string) {
      const rows = await owner`select result_json::jsonb as json
        from ewoh_control_result where command_id = ${commandId} and result_type = 'gateway_ack' limit 1`;
      const json = rows[0]?.json as { fingerprintVerified?: boolean; fingerprintNote?: string } | undefined;
      return { verified: json?.fingerprintVerified, note: json?.fingerprintNote ?? null };
    }

    async function projectionView(commandId: string) {
      const res = await apiRequest<Boundary>(
        baseUrl,
        `/api/control/requests?deviceId=${deviceId}&limit=50`,
        { headers: jsonHeaders(adminToken) },
      );
      expect(res.status).toBe(200);
      const row = (res.body.commands ?? []).find((c) => c.commandId === commandId);
      expect(row).toBeDefined();
      return row!;
    }

    it('VP-01 现状钉住：网关上报"未验签（缺密钥）"，读面仍报 fingerprintVerified=true', async () => {
      const commandId = await dispatch('unverified');
      await ack(commandId, false, 'fingerprint_secret_missing');

      const stored = await storedAckVerdict(commandId);
      const view = await projectionView(commandId);
      console.log(
        `[V95] VP-01 网关上报=${JSON.stringify(stored)} | 库里 ack.fingerprintVerified=${stored.verified} `
        + `| 读面 fingerprintVerified=${view.fingerprintVerified} scheme=${view.fingerprintScheme} `
        + `| 读面 ack=${JSON.stringify(view.ack)}`,
      );

      // 网关的结论确实落库了（否则"读面不一致"就无从谈起）
      expect(stored.verified).toBe(false);
      expect(stored.note).toBe('fingerprint_secret_missing');
      // 但运维读面不看它：字段来自平台侧复核时间戳
      expect(view.fingerprintVerified).toBe(true);
      // 读面暴露的 ack 事实只有 delivered/reason/at —— 没有任何验签字段
      expect(Object.keys(view.ack ?? {}).sort()).toEqual(['at', 'delivered', 'reason']);
    }, 120_000);

    it('VP-02 判别对照：网关上报"已验签"与"未验签"在读面上完全同值', async () => {
      const unverified = await dispatch('pair-false');
      await ack(unverified, false, 'fingerprint_secret_missing');
      const verified = await dispatch('pair-true');
      await ack(verified, true, 'signature verified');

      const storedFalse = await storedAckVerdict(unverified);
      const storedTrue = await storedAckVerdict(verified);
      const viewFalse = await projectionView(unverified);
      const viewTrue = await projectionView(verified);
      console.log(
        `[V95] VP-02 网关上报 false/true → 库里 ${storedFalse.verified}/${storedTrue.verified}；`
        + `读面 ${viewFalse.fingerprintVerified}/${viewTrue.fingerprintVerified}`,
      );

      expect([storedFalse.verified, storedTrue.verified]).toEqual([false, true]);
      // 两条上报相反的命令，读面却是同一个值 ⇒ 该字段与网关结论无关（口径不同源）
      expect(viewFalse.fingerprintVerified).toBe(viewTrue.fingerprintVerified);
      expect(viewTrue.fingerprintVerified).toBe(true);
    }, 120_000);
  },
);
