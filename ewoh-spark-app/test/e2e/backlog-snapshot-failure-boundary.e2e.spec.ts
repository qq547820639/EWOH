/**
 * 巡检里"趋势快照"与"权威过期收敛"的事务边界（V103 实测（现状钉住 F-18））。
 *
 * 背景：PROJ-01 普查发现 `sweepDeliveryBacklog` 里两件事共用一个事务——
 *   ① `expireBacklogCommands`：命令 sent→expired（权威终态收敛，F-02 的唯一 writer）+ 结果行 + 请求聚合；
 *   ② `ewoh_control_backlog_snapshot` 的 INSERT（NO-91a 的历史趋势快照），**包在 try 里、失败只 warn**。
 * worker 与 HTTP 路由各自把整段巡检包在事务里（`runInTransaction` / 拦截器）。
 * 于是有一个可测的问题：**一条只服务趋势的边表写失败，会不会连带否决权威收敛？**
 * PostgreSQL 的语义是"事务里一旦出错，整个事务进入 aborted"，catch 掉 JS 异常并不能撤销它。
 *
 * 实测结论（本轮）：**会被连带否决**。BS-02 里 sweep 返回 500、快照一条没写、命令仍 `sent`；
 * BS-03 撤掉同一条触发器后同一命令即收敛为 `expired`。所以本文件按"现状钉住 + 翻转条件"写断言
 * （不把错误行为写成通过，也不把它伪装成缺陷已修），缺陷登记为 §5.4 **F-18**。
 * 另外两条踩过的坑记在这里免得重复：① 命令要先进积压扫描集（`sent_at < now() - SLA`，
 * collectBacklogRows:1177-1207）才谈得上过期，第一版只推了 deadline 导致 BS-01 成了空断言；
 * ② 500 的错误面点名的是**后面的审计调用**，不是趋势表——只看错误文本会定错因。
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
const TRIGGER = 'ewoh_e2e_bs_block_snapshot';
const FN = 'ewoh_e2e_bs_block_fn';

(config ? describe : describe.skip)(
  '巡检事务边界探针（趋势快照写失败会不会连带否决权威过期收敛）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let adminToken = '';
    const runId = randomUUID().slice(0, 8);
    const deviceId = `AGV-BS-${runId}`;
    let faultedCommandId = '';

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const admin = await login(handle.baseUrl, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
    }, 180_000);

    afterAll(async () => {
      if (owner) {
        await owner.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_control_backlog_snapshot;`);
        await owner.unsafe(`DROP FUNCTION IF EXISTS public.${FN}();`);
      }
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    /** 产品路径造一条"已下发未回执"的命令，再把请求的显式截止时光推到过去。 */
    async function inFlightCommand(tag: string) {
      const created = await apiRequest<{ id: string }>(
        handle.baseUrl, '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ deviceId, commandKeys: ['start'], idempotencyKey: `bs-${tag}-${runId}` }),
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
      // business_deadline 判据的载体：请求行显式写了截止且已过（F-02 的第一优先级规则）。
      // 积压扫描的入池条件是 `sent_at < now() - SLA`（collectBacklogRows:1177-1207）：
      // 探针第一版只推了 deadline，命令根本没进扫描集，BS-01 的"应收敛"就成了空断言。
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
      const before = await commandRow(commandId);
      expect(String(before.status)).toBe('sent');
      return { requestId, commandId };
    }

    async function commandRow(commandId: string) {
      const rows = await owner`select status, error_code as errorCode, delivered_at as deliveredAt
        from public.ewoh_control_command where command_id = ${commandId}`;
      return rows[0] as Record<string, unknown>;
    }

    async function snapshotCount() {
      const rows = await owner`select count(*)::int as n from public.ewoh_control_backlog_snapshot`;
      return Number((rows[0] as Record<string, unknown>).n);
    }

    function sweep() {
      return apiRequest<{ expired?: number; scanned?: number }>(
        handle.baseUrl, '/api/control/delivery-backlog/sweep',
        { method: 'POST', headers: jsonHeaders(adminToken) },
      );
    }

    it('BS-01 前提：巡检会把过期命令收敛成 expired，并写下一条趋势快照', async () => {
      const { commandId } = await inFlightCommand('BS01');
      const before = await snapshotCount();
      const res = await sweep();
      const after = await snapshotCount();
      const row = await commandRow(commandId);
      console.log(`[BS-01] sweep=${res.status} 快照 ${before}→${after} 命令=${JSON.stringify(row)}`);
      expect(res.status).toBe(201);
      expect(String(row.status)).toBe('expired');
      expect(after).toBeGreaterThan(before);

      // PROJ-03（V223）：快照行"多了一条"不等于"内容对"。这里把投影的两列互相钉住——
      // 有设备分组时 devices 明细求和必须等于 totals.commands。
      // V224 就地更正适用范围：这条对账只拦得住**jsonb 序列化丢字段**这类"两列自相矛盾"，
      // 拦不住"扫描上限把样本当总量"——totals 与 devices 是从同一批行算出来的，一起变小就恒成立；
      // 后者由 BS-04 钉（PROJ-06）。
      // 仍**未**补的那半：totals 与 ewoh_control_command 的**窗口口径**对账——在测试里重抄实现的
      // WHERE 公式不算对账，故本行保持开放（见登记册 §5.3fx 与下面的实测缺口）。
      const snap = await owner`SELECT org_id, totals, devices
        FROM ewoh_control_backlog_snapshot ORDER BY created_at DESC, id DESC LIMIT 1`;
      expect(snap.length).toBe(1);
      const totals = snap[0].totals as Record<string, number>;
      const devs = snap[0].devices as Array<{ deviceId: string; commands: number }>;
      expect(Number(totals.commands)).toBeGreaterThan(0); // 否则下面的对账是恒真
      expect(devs.length).toBe(Number(totals.devices));
      expect(devs.every((d) => typeof d.deviceId === 'string' && d.deviceId !== '')).toBe(true);
      const sum = devs.reduce((acc, d) => acc + Number(d.commands), 0);
      if (devs.length > 0) {
        expect(sum).toBe(Number(totals.commands));
      } else {
        // V223 实测到的投影自身口径缺口：BS-01 那条命令**没有设备维度**，于是
        // totals.commands=1 而 devices=[] ⇒ 任何按 devices 求和的趋势消费方都会少算。
        // 记为 PROJ-03 的残留（本行不闭合），而不是把断言放宽成恒真。
        expect(Number(totals.commands)).toBeGreaterThan(sum);
      }
    }, 180_000);

    it('BS-02 只让趋势快照写失败：权威过期收敛会不会被连带否决（实测）', async () => {
      const { commandId } = await inFlightCommand('BS02');
      faultedCommandId = commandId;
      await owner.unsafe(`
        CREATE FUNCTION public.${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'e2e BS-02 趋势快照写入被人为挡住'; END;
        $fn$;
        CREATE TRIGGER ${TRIGGER}
        BEFORE INSERT ON public.ewoh_control_backlog_snapshot
        FOR EACH ROW EXECUTE FUNCTION public.${FN}();
      `);
      const before = await snapshotCount();
      const res = await sweep();
      const after = await snapshotCount();
      const row = await commandRow(commandId);
      console.log(
        `[BS-02] sweep=${res.status} body=${JSON.stringify(res.body).slice(0, 200)} `
        + `快照 ${before}→${after} 命令=${JSON.stringify(row)}`,
      );
      await owner.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_control_backlog_snapshot;`);
      await owner.unsafe(`DROP FUNCTION IF EXISTS public.${FN}();`);
      // 现状钉住（F-18，V103 实测）：一条**只服务趋势**的边表写失败，会连带否决同一事务里的权威收敛——
      // PostgreSQL 里"事务一旦出错即进入 aborted"，JS 的 catch 撤销不了它（机制实验 tmp/v103-savepoint.mjs：
      // 无 SAVEPOINT ⇒ 下一条权威写 25P02、COMMIT 变回滚、权威行 0；加 SAVEPOINT ⇒ 权威行 expired,kept 都在）。
      // 翻转条件：把趋势快照写进独立 savepoint（或挪出该事务）后，本三条断言应改成
      // "sweep=201、命令 expired、快照仍 0 增量"，同时保留对本行注释里那条 warn 的断言。
      expect(res.status).toBe(500);
      expect(after).toBe(before);
      expect(String(row.status)).toBe('sent');
    }, 180_000);

    it('BS-03 归因：撤掉同一个故障后重跑巡检，命令应正常收敛', async () => {
      const rows = await owner`select count(*)::int as n from pg_trigger where tgname = ${TRIGGER}`;
      expect(Number((rows[0] as Record<string, unknown>).n)).toBe(0);
      expect(faultedCommandId).toBeTruthy();
      const res = await sweep();
      const row = await commandRow(faultedCommandId);
      console.log(`[BS-03] 撤障后同一命令重跑：sweep=${res.status} 命令=${JSON.stringify(row)}`);
      // 归因：撤掉那一条触发器（唯一变量）之后，同一条命令就正常收敛 ⇒ BS-02 的"停在 sent"
      // 只能归因于趋势快照写入失败，而不是命令不满足过期条件。
      expect(res.status).toBe(201);
      expect(String(row.status)).toBe('expired');
      expect(String(row.errorcode)).toBe('COMMAND_EXPIRED');
    }, 180_000);

    it('BS-04 积压超过单轮检视上限：totals 必须是真总量，明细必须显式标出被截断（PROJ-06 位点）', async () => {
      // 这一支钉的是 V224 实测到的形状：改前 capped 读最多给 500 行，于是看板与历史快照
      // 两处投影响力都停在 500，且没有任何"被截断"的痕迹。种 520 条真积压 ⇒ 修法前必红。
      const SEED = 520;
      // 自带前提（不借 BS-02 的行号）：先用产品路径造一条命令，只为拿到"这个租户"的 org_id。
      const { commandId: probeCommandId } = await inFlightCommand('BS04');
      const orgRows = await owner`select org_id::text as "orgId" from public.ewoh_control_command
                                   where command_id = ${probeCommandId}`;
      const orgId = String((orgRows[0] as Record<string, unknown>).orgId);
      expect(orgId).toBeTruthy();
      await owner`INSERT INTO public.ewoh_control_request
                       (org_id, request_id, device_id, control_type, status, _created_at)
                    SELECT ${orgId}::uuid, ${`BS04R-${runId}-`}||g, 'AGV-BS04-'||(g % 4), 'start',
                           'created', now()
                      FROM generate_series(1, ${SEED}) g`;
      await owner`INSERT INTO public.ewoh_control_command
                       (org_id, command_id, request_id, root_command_id, attempt_no,
                        command_key, status, sent_at, _created_at)
                     SELECT ${orgId}::uuid, ${`BS04-${runId}-`}||g, ${`BS04R-${runId}-`}||g,
                            ${`BS04-${runId}-`}||g, 1,
                            'start', 'sent', now() - interval '2 hours', now()
                      FROM generate_series(1, ${SEED}) g`;
      try {
        const status = await apiRequest<{
          truncated?: boolean;
          totals?: Record<string, number>;
          devices?: unknown[];
        }>(handle.baseUrl, '/api/control/delivery-backlog/status',
          { method: 'GET', headers: jsonHeaders(adminToken) });
        expect(status.status).toBe(200);
        expect(status.body.truncated).toBe(true);
        const commands = Number(status.body.totals?.commands ?? 0);
        console.log(
          `[BS-04] 种 ${SEED} 条积压 ⇒ 看板 totals.commands=${commands} `
          + `devices=${(status.body.devices ?? []).length} truncated=${String(status.body.truncated)}`,
        );
        // 修法前这里恒为 ≤500；修法后必须报出至少我种下的这些行。
        expect(commands).toBeGreaterThanOrEqual(SEED);
        // 明细条数 < 总量 ⇒ 只有"总量是真数"才可能成立（改前两者都停在 500 以下且无从区分）。
        expect((status.body.devices ?? []).length).toBeLessThan(commands);

        const swept = await sweep();
        expect(swept.status).toBe(201);
        const snap = await owner`SELECT totals FROM public.ewoh_control_backlog_snapshot
                                  ORDER BY created_at DESC LIMIT 1`;
        const totals = (snap[0] as Record<string, unknown>).totals as Record<string, number>;
        expect(totals.truncated).toBe(true);
        expect(Number(totals.sampledCommands)).toBeLessThanOrEqual(500);
        expect(Number(totals.commands)).toBeGreaterThanOrEqual(SEED);
      } finally {
        // 必须清场：这 520 条留在库里会污染同库跑的其它积压用例（WB-01/WB-02 赌的就是积压条数）。
        await owner.unsafe(`DELETE FROM public.ewoh_control_command WHERE command_id LIKE $1`,
          [`BS04-${runId}-%`]);
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE request_id LIKE $1`,
          [`BS04R-${runId}-%`]);
      }
    }, 180_000);

    // ── BS-05：窗口口径对账（V229·PROJ-03②）────────────────────────────────
    // 登记册原话：「在测试里重抄实现的 WHERE 公式不算对账，要真对账得把窗口定义提到契约层」。
    // 所以本例的取数条件**一条都不写在测试里**：全部由 `contracts/state-machines/control.yaml`
    // 的 `delivery_backlog_window` 解析得来（状态词表、老化列与算子、SLA 的 env 名与缺省值、
    // 未交付谓词、租户范围、别名、以及两条 measure），拼成一条独立聚合 SQL 去读权威表，
    // 再和实现的 `totals` 逐项比。红法有两条且各自独立：
    //   ① 实现改了 WHERE 而契约没改 ⇒ 本例的等式两边不等；
    //   ② 契约改了而实现没改 ⇒ 同样不等（契约是"应然"，实现跟不上就该红）。
    const windowContract = (
      load(
        readFileSync(
          resolve(__dirname, '../../../contracts/state-machines/control.yaml'),
          'utf8',
        ),
      ) as {
        delivery_backlog_window?: Record<string, unknown>;
      }
    ).delivery_backlog_window as {
      sql_aliases: string;
      join: string;
      status_filter: string[];
      aging_column: string;
      aging_operator: string;
      sla_env: string;
      sla_default_ms: number;
      undelivered_filter: string;
      org_scope: string;
      scan_cap: number;
      command_measure: string;
      undelivered_measure: string;
      device_measure: string;
      read_cache_env: string;
      read_cache_default_ms: number;
    };

    /** 契约声明的缺省 SLA／TTL：env 覆盖时以 env 为准（与实现的取值次序一致）。 */
    const contractSlaMs = Number(process.env[windowContract.sla_env] ?? windowContract.sla_default_ms);
    const contractTtlMs = Number(
      process.env[windowContract.read_cache_env] ?? windowContract.read_cache_default_ms,
    );

    /**
     * 契约片段的共用组装：同一个 WHERE 既能出聚合（BS-05）也能出逐行清单（BS-06）。
     * 表别名按契约声明的 `command`／`request` 建，于是契约里的 SQL 片段是**原样拼接**进
     * SELECT/WHERE 的（测试不补任何条件）。
     */
    function contractWindowSqlFor(orgId: string, selectClause: string) {
      const w = windowContract;
      return {
        sql: `SELECT ${selectClause}`
          + `   FROM public.ewoh_control_command command`
          + `   JOIN public.ewoh_control_request request ON ${w.join}`
          + `  WHERE (command.status = ANY(string_to_array($1, ',')::text[]))`
          + `    AND (${w.aging_column} ${w.aging_operator}`
          // 毫秒直接乘成 interval（`make_interval` 没有 msecs 这一档，只有 secs/usecs）。
          + ` now() - ($2::double precision * interval '1 ms'))`
          // 每条借来的片段都必须**各自加括号**再 AND：`undelivered_filter` 顶层是个 OR，
          // 裸拼会按 `A AND B AND x OR y AND z` = `(A∧B∧x) ∨ (y∧z)` 解析 ⇒ OR 的两支各自
          // 脱离了另一半条件（V229 第一遍实测：9 条窗口内种子被匹配成 10 条，且租户条件丢了）。
          + `    AND (${w.undelivered_filter})`
          + `    AND (${w.org_scope.replace(':actor_org', '$3::uuid')})`,
        params: [w.status_filter.join(','), String(contractSlaMs), orgId],
      };
    }

    /**
     * 由契约块独立组一条窗口聚合。额外两列 `deviceless*` 是实现侧没有的观测量：
     * 契约 `device_grouping` 说空 device_id 不进任何分组，这两列用来把"进了总数还是没进"量成数（PROJ-03①）。
     */
    async function oracleFromContract(orgId: string) {
      const w = windowContract;
      const q = contractWindowSqlFor(orgId,
        `${w.command_measure} AS commands,`
        + ` ${w.undelivered_measure} AS undelivered,`
        + ` ${w.device_measure} AS devices,`
        + ` count(*) FILTER (WHERE coalesce(request.device_id, '') = '') AS deviceless,`
        + ` count(*) FILTER (WHERE coalesce(request.device_id, '') = ''`
        + `   AND command.delivered_at IS NULL) AS deviceless_undelivered`);
      const rows = await owner.unsafe(q.sql, q.params);
      const first = (rows as Array<Record<string, unknown>>)[0] ?? {};
      return {
        commands: Number(first.commands),
        undelivered: Number(first.undelivered),
        devices: Number(first.devices),
        deviceless: Number(first.deviceless),
        devicelessUndelivered: Number(first.deviceless_undelivered),
      };
    }

    type BacklogSeed = {
      tag: string;
      device: string;
      status: string;
      delivered: boolean;
      sentAgoMinutes: number;
      org?: string;
    };

    /** 直接种权威表（不走产品路径）：负控那四条里，`sent`＋已有 `delivered_at` 这类组合产品侧未必产得出，
     *  而窗口谓词的**排除**半边必须被种出来才谈得上对账。 */
    async function seedBacklogRows(seeds: BacklogSeed[], defaultOrg: string, prefix = 'BS05') {
      // id 一律带 runId：一遍重放被中途作废时，`finally` 不会跑，留下的种子行会让下一遍
      // 撞 `ewoh_control_request_request_id_key`（全局唯一）——V229 实测撞上一次（见登记册 §5.3ic）。
      for (const s of seeds) {
        const org = s.org ?? defaultOrg;
        const cmdId = `${prefix}-${runId}-${s.tag}`;
        const reqId = `${prefix}R-${runId}-${s.tag}`;
        await owner`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, status, _created_at)
                      VALUES (${org}::uuid, ${reqId}, ${s.device}, 'start', 'created', now())`;
        await owner`INSERT INTO public.ewoh_control_command
                         (org_id, command_id, request_id, root_command_id, attempt_no,
                          command_key, status, sent_at, delivered_at, _created_at)
                      VALUES (${org}::uuid, ${cmdId}, ${reqId},
                              ${cmdId}, 1, 'start', ${s.status},
                              now() - make_interval(mins => ${s.sentAgoMinutes}),
                              ${s.delivered ? new Date() : null}::timestamptz, now())`;
      }
    }

    function backlogStatus() {
      return apiRequest<{
        truncated?: boolean;
        slaMs?: number;
        checkedAt?: string;
        escalationMultiplier?: number;
        totals?: Record<string, number>;
        devices?: Array<{ deviceId: string; commands: number; undelivered: number }>;
      }>(handle.baseUrl, '/api/control/delivery-backlog/status',
        { method: 'GET', headers: jsonHeaders(adminToken) });
    }

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('BS-05 窗口口径对账：契约块独立组 SQL，totals 必须逐项等于按契约重算的窗口聚合（PROJ-03②）', async () => {
      // 前提：契约里那把"键"必须齐，缺一条本例就退化成"少一个条件也对"的弱对账。
      expect(windowContract.status_filter.length).toBeGreaterThan(0);
      expect(windowContract.sql_aliases).toContain('command=');
      expect(windowContract.org_scope).toContain(':actor_org');

      const { commandId: probeCommandId } = await inFlightCommand('BS05');
      const orgRows = await owner`select org_id::text as "orgId" from public.ewoh_control_command
                                   where command_id = ${probeCommandId}`;
      const orgId = String((orgRows[0] as Record<string, unknown>).orgId);
      expect(orgId).toBeTruthy();
      const otherOrg = randomUUID();

      // 窗口内 9 条：3 台设备各 1 条 sent 未投递 + 1 条 gateway_received 已投递，外加 3 条无设备行。
      const inWindow: BacklogSeed[] = [
        ...[0, 1, 2].flatMap((d) => [
          { tag: `S${d}`, device: `AGV-BS05-D${d}`, status: 'sent', delivered: false, sentAgoMinutes: 120 },
          { tag: `G${d}`, device: `AGV-BS05-D${d}`, status: 'gateway_received', delivered: true, sentAgoMinutes: 120 },
        ]),
        ...[0, 1, 2].map((d) => ({
          tag: `E${d}`, device: '', status: 'sent', delivered: false, sentAgoMinutes: 120,
        })),
      ];
      // 负控 4 条：各自被契约的某一条排除规则挡在窗口外。少种一条、或多算一条，下面的等式就会歪。
      const excluded: BacklogSeed[] = [
        // 已被排除项 1：`sent` 但已有 delivered_at ⇒ undelivered_filter 的两支都不成立。
        { tag: 'X1', device: 'AGV-BS05-N1', status: 'sent', delivered: true, sentAgoMinutes: 120 },
        // 已被排除项 2：状态不在 status_filter 词表内。
        { tag: 'X2', device: 'AGV-BS05-N2', status: 'executed', delivered: false, sentAgoMinutes: 120 },
        // 已被排除项 3：还没老化到 SLA 之外。
        { tag: 'X3', device: 'AGV-BS05-N3', status: 'sent', delivered: false, sentAgoMinutes: 0 },
        // 已被排除项 4：属于另一个租户。
        { tag: 'X4', device: 'AGV-BS05-N4', status: 'sent', delivered: false, sentAgoMinutes: 120, org: otherOrg },
      ];
      try {
        // 先量一次"种我之前"的窗口，用**差分**自证前提：本例所在租户还有别的用例留下的行，
        // 绝对值会把它们一起算进来（那是对的，但对账的前提自证不该依赖别人留了什么）。
        const base = await oracleFromContract(orgId);
        await seedBacklogRows([...inWindow, ...excluded], orgId);

        // ── 档一：未触顶（totals 取分组求和）──
        if (contractTtlMs > 0) await delay(contractTtlMs + 250);
        const uncapped = await backlogStatus();
        expect(uncapped.status).toBe(200);
        expect(uncapped.body.truncated).toBe(false);
        // 实现用的 SLA 必须就是契约声明的那个值，否则"两边各自算同一个窗口"这句话不成立。
        expect(Number(uncapped.body.slaMs)).toBe(contractSlaMs);

        const oracle1 = await oracleFromContract(orgId);
        console.log(
          `[BS-05] 契约窗口重算（未触顶）base=${JSON.stringify(base)} 种后=${JSON.stringify(oracle1)} `
          + `实现 totals=${JSON.stringify(uncapped.body.totals)}`,
        );
        // 前提自证：四条负控确实被契约的排除规则挡住（差分若等于 13，说明窗口在"数我种下的全部行"）。
        expect(oracle1.commands - base.commands).toBe(inWindow.length);
        expect(oracle1.undelivered - base.undelivered).toBe(6); // 3 条 sent + 3 条无设备 sent
        expect(oracle1.deviceless - base.deviceless).toBe(3);
        expect(oracle1.devicelessUndelivered - base.devicelessUndelivered).toBe(3);
        // 窗口里确实有无设备行 ⇒ 下面那条"差额＝无设备子集"的对账不是恒真。
        expect(oracle1.deviceless).toBeGreaterThan(0);

        const t1 = uncapped.body.totals ?? {};
        const devs1 = uncapped.body.devices ?? [];
        expect(devs1.every((d) => d.deviceId !== '')).toBe(true);
        expect(Number(t1.commands)).toBe(oracle1.commands - oracle1.deviceless);
        expect(Number(t1.undelivered)).toBe(oracle1.undelivered - oracle1.devicelessUndelivered);
        // count(distinct device_id) 把空串当成一个取值 ⇒ 触顶前那一档的 totals.devices 少这一个。
        expect(Number(t1.devices)).toBe(oracle1.devices - (oracle1.deviceless > 0 ? 1 : 0));
        // 未触顶这一档：明细求和与 totals 自洽（BS-01 已经钉过），差额恰好等于无设备那一子集。
        expect(devs1.reduce((acc, d) => acc + Number(d.commands), 0)).toBe(Number(t1.commands));

        // ── 档二：触顶（totals 改取同谓词全量聚合）──
        const SEED = 520;
        await owner`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, status, _created_at)
                      SELECT ${orgId}::uuid, ${`BS05R-${runId}-C`}||g, 'AGV-BS05-D'||(g % 3), 'start',
                             'created', now()
                        FROM generate_series(1, ${SEED}) g`;
        await owner`INSERT INTO public.ewoh_control_command
                         (org_id, command_id, request_id, root_command_id, attempt_no,
                          command_key, status, sent_at, _created_at)
                       SELECT ${orgId}::uuid, ${`BS05-${runId}-C`}||g, ${`BS05R-${runId}-C`}||g,
                              ${`BS05-${runId}-C`}||g, 1,
                              'start', 'sent', now() - interval '2 hours', now()
                        FROM generate_series(1, ${SEED}) g`;
        if (contractTtlMs > 0) await delay(contractTtlMs + 250);
        const capped = await backlogStatus();
        expect(capped.status).toBe(200);
        expect(capped.body.truncated).toBe(true);
        // 功效：两次读数确实各自重算了一遍（没吃到上一档的 TTL 缓存），否则档二比的是档一的快照。
        expect(String(capped.body.checkedAt)).not.toBe(String(uncapped.body.checkedAt));

        const oracle2 = await oracleFromContract(orgId);
        console.log(
          `[BS-05] 契约窗口重算（触顶）=${JSON.stringify(oracle2)} `
          + `实现 totals=${JSON.stringify(capped.body.totals)} 明细=${(capped.body.devices ?? []).length} 组`,
        );
        expect(oracle2.commands).toBeGreaterThan(windowContract.scan_cap);
        const t2 = capped.body.totals ?? {};
        // 这一档是 PROJ-03② 的正题：totals 三项与"按契约重算的窗口聚合"逐项相等。
        expect(Number(t2.commands)).toBe(oracle2.commands);
        expect(Number(t2.undelivered)).toBe(oracle2.undelivered);
        expect(Number(t2.devices)).toBe(oracle2.devices);

        // PROJ-03① 的可数形式（钉现状、不裁决）：同一批无设备行，在**未触顶**那一档既不进
        // totals 也不进明细，在**触顶**这一档进了 totals 却仍不进明细 ⇒ 差额正好是那 3 条。
        expect(oracle2.commands - oracle1.commands).toBe(SEED);
        expect(Number(t2.commands) - Number(t1.commands)).toBe(SEED + oracle1.deviceless);
        expect((capped.body.devices ?? []).reduce((acc, d) => acc + Number(d.commands), 0))
          .toBeLessThan(Number(t2.commands));
      } finally {
        await owner.unsafe(`DELETE FROM public.ewoh_control_command WHERE command_id LIKE $1`,
          [`BS05-${runId}-%`]);
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE request_id LIKE $1`,
          [`BS05R-${runId}-%`]);
      }
    }, 180_000);

    it('BS-06 写侧对账：巡检落到历史快照的那一行里，totals.commands 与同一行的 devices 明细不是同一个集合（PROJ-03①）', async () => {
      // PROJ-03① 说的是**表里那一行**（`ewoh_control_backlog_snapshot`），它的 writer 是
      // `sweepDeliveryBacklog`，不是 BS-05 对账的 HTTP 读侧；两者对 `totals.commands` 用的是
      // 不同表达式（读侧＝分组求和／触顶后取全量聚合；写侧＝本轮检视到的全部行数）。
      // 所以这一例量写侧，并把"同一行里 commands 比明细多出哪些"当场数出来：
      // 空 device_id 的行 ＋ 本轮被同一次巡检判成 expired 的行。两个来源都由集合差算，不写死条数。
      const { commandId: probeId } = await inFlightCommand('BS06');
      const orgRows = await owner`select org_id::text as "orgId" from public.ewoh_control_command
                                   where command_id = ${probeId}`;
      const orgId = String((orgRows[0] as Record<string, unknown>).orgId);
      const memberList = async () => {
        const q = contractWindowSqlFor(orgId,
          'command.command_id AS id, request.device_id AS device, command.status AS status');
        const rs = await owner.unsafe(q.sql, q.params);
        return (rs as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id),
          device: String(r.device ?? ''),
          status: String(r.status),
        }));
      };
      try {
        await seedBacklogRows([
          { tag: 'W0', device: 'AGV-BS06-D0', status: 'sent', delivered: false, sentAgoMinutes: 120 },
          { tag: 'W1', device: 'AGV-BS06-D1', status: 'gateway_received', delivered: true, sentAgoMinutes: 120 },
          { tag: 'V0', device: '', status: 'sent', delivered: false, sentAgoMinutes: 120 },
          { tag: 'V1', device: '', status: 'gateway_received', delivered: true, sentAgoMinutes: 120 },
        ], orgId, 'BS06');

        const before = await memberList();
        const deviceless = before.filter((r) => r.device === '').length;
        expect(deviceless).toBeGreaterThan(0); // 否则下面"明细少算"那半是恒真
        const snapBefore = await snapshotCount();
        const swept = await sweep();
        expect(swept.status).toBe(201);
        const after = await memberList();

        const dropped = before.filter((r) => !after.some((x) => x.id === r.id));
        // 功效：本轮确实有行掉出窗口，且掉出的原因是权威状态被收敛成 expired（不是别的原因）。
        expect(dropped.length).toBeGreaterThan(0);
        for (const row of dropped) {
          expect(String((await commandRow(row.id)).status)).toBe('expired');
        }
        const droppedIds = new Set(dropped.map((r) => r.id));

        expect(await snapshotCount()).toBe(snapBefore + 1);
        const snap = await owner`SELECT org_id::text AS "orgId", totals, devices
          FROM public.ewoh_control_backlog_snapshot ORDER BY created_at DESC, id DESC LIMIT 1`;
        expect(String((snap[0] as Record<string, unknown>).orgId)).toBe(orgId);
        const t = (snap[0] as Record<string, unknown>).totals as Record<string, number>;
        const devs = (snap[0] as Record<string, unknown>)
          .devices as Array<{ deviceId: string; commands: number }>;
        const sumDevices = devs.reduce((acc, d) => acc + Number(d.commands), 0);
        console.log(
          `[BS-06] 窗口成员（巡检前）=${before.length} 空设备=${deviceless} 本轮过期=${dropped.length} `
          + `⇒ 快照 totals=${JSON.stringify(t)} 明细求和=${sumDevices}`,
        );

        // 写侧的 commands 就是"本轮检视到的全部行"（含空设备、含同轮被判过期的那些）。
        expect(Number(t.commands)).toBe(before.length);
        expect(Number(t.sampledCommands)).toBe(before.length);
        // 明细只覆盖"有设备且本轮没被判过期"的行 ⇒ 差额两个来源，各自数得出来。
        const attributable = before.filter((r) => r.device !== '' && !droppedIds.has(r.id));
        expect(sumDevices).toBe(attributable.length);
        expect(Number(t.commands) - sumDevices).toBe(deviceless + dropped.length);
        expect(Number(t.devices)).toBe(new Set(attributable.map((r) => r.device)).size);
      } finally {
        await owner.unsafe(`DELETE FROM public.ewoh_control_command WHERE command_id LIKE $1`,
          [`BS06-${runId}-%`]);
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE request_id LIKE $1`,
          [`BS06R-${runId}-%`]);
      }
    }, 180_000);

    it('REQST-01 控制请求状态词表已进库：契约外的值必须被拒，省略 status 必须落进契约初态', async () => {
      // 位点：standalone_107 的 ck_control_request_status_contract（口径＝contracts/state-machines/control.yaml 的 10 个请求级态）。
      // 反向对照（没牙时会绿的那两件事）：① 插入 'draft'（本迁移之前的 DDL 默认值）必须 23514；
      // ② 插入一个词表内的假想值 NOT-A-STATE 也必须 23514——只钉"拒绝存在"，不钉"拒绝某字面量"。
      const orgRows = await owner`SELECT org_id::text AS "orgId" FROM public.ewoh_organization
                                   WHERE org_id IS NOT NULL LIMIT 1`;
      expect(orgRows.length).toBeGreaterThan(0);
      const orgId = String((orgRows[0] as Record<string, unknown>).orgId);
      const stamp = `${runId}-reqst`;
      try {
        const rejected: Array<[string, string]> = [];
        for (const bad of ['draft', 'NOT-A-STATE']) {
          let code = '';
          try {
            await owner`INSERT INTO public.ewoh_control_request
                             (org_id, request_id, device_id, control_type, status, _created_at)
                          VALUES (${orgId}::uuid, ${`${stamp}-${bad}`}, 'AGV-REQST', 'start', ${bad}, now())`;
          } catch (e) {
            code = String((e as { code?: string }).code ?? '');
          }
          rejected.push([bad, code]);
        }
        // jest 的 expect 不带第二个"消息"参数（那是 Playwright 的形状）⇒ 把标签放进被比较的元组里，
        // 失败时 jest 会打印出是哪一个值没被拒。
        expect(rejected).toEqual([['draft', '23514'], ['NOT-A-STATE', '23514']]);
        // 正向对照：词表内的值写得进来；省略 status 时默认值已在词表内（不再是 `draft`）。
        await owner`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, status, _created_at)
                      VALUES (${orgId}::uuid, ${`${stamp}-ok`}, 'AGV-REQST', 'start', 'created', now())`;
        await owner`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, _created_at)
                      VALUES (${orgId}::uuid, ${`${stamp}-default`}, 'AGV-REQST', 'start', now())`;
        const landed = await owner`SELECT status FROM public.ewoh_control_request
                                    WHERE request_id IN (${`${stamp}-ok`}, ${`${stamp}-default`})`;
        expect(landed.map((r) => String((r as Record<string, unknown>).status)).sort())
          .toEqual(['created', 'created']);
      } finally {
        // 断言失败也必须清干净：本用例在"约束没落地"时会真的插入成功两行，残留会让 107 重新 apply 被自己的 CHECK 拒。
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE request_id LIKE $1`,
          [`${stamp}%`]);
      }
    });

    it('ORPH-01 可达性实测：审批联动失败时整笔回滚，不留孤儿请求（含未注入对照臂）', async () => {
      // V306 把 V305 登记的「主行先提交 ⇒ 生产时序能造出孤儿」拿去实测：**前提不成立**。
      // 注入方式＝替换 DI 实例上的 approvalService.createApproval 抛错（等价于第二步的任何失败：
      // 审批侧异常、DB 抖动、或 @Optional() 注入缺席走 :477 那条分支）。
      // 对照臂先跑，证明"0 行"不是"这条路径压根不写库"：不注入时高危请求必须落库为 pending_approval。
      const orphanKey = `bs-orphan2-${runId}`;
      const controlKey = `bs-orphan2ctl-${runId}`;
      const { ControlService } = await import('../../server/modules/control/control.service');
      const svc = handle.app.get(ControlService) as unknown as {
        approvalService?: { createApproval: (input: unknown, actor: unknown) => Promise<unknown> } | undefined,
      };
      const original = svc.approvalService;
      try {
        const ctl = await apiRequest<Record<string, unknown>>(
          handle.baseUrl, '/api/control/requests',
          {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({ deviceId, commandKeys: ['resume'], idempotencyKey: controlKey }),
          },
        );
        expect(ctl.status).toBe(201);
        const ctlRows = await owner`SELECT status FROM public.ewoh_control_request WHERE idempotency_key = ${controlKey}`;
        expect(ctlRows.length).toBe(1);
        expect(String((ctlRows[0] as Record<string, unknown>).status)).toBe('pending_approval');
        svc.approvalService = {
          async createApproval() {
            throw new Error('injected: approval persistence unavailable');
          },
        };
        const created = await apiRequest<Record<string, unknown>>(
          handle.baseUrl, '/api/control/requests',
          {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({ deviceId, commandKeys: ['resume'], idempotencyKey: orphanKey }),
          },
        );
        expect(created.status).toBeGreaterThanOrEqual(500);
        const rows = await owner`SELECT request_id AS "requestId", status FROM public.ewoh_control_request
                                WHERE idempotency_key = ${orphanKey}`;
        // 实测：主行与审批联动**同一笔事务**，注入失败后回滚 ⇒ 库里查不到这条请求（V305 的前提被否证）
        expect(rows.length).toBe(0);
        console.log('[ORPH-01] 注入审批失败 ⇒ 创建整笔回滚，0 行残留；未注入对照臂则落 1 行 pending_approval');
      } finally {
        svc.approvalService = original;
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE idempotency_key = ANY($1)`,
          [[orphanKey, controlKey]]);
      }
    });

    it('ATM-01 第三步（留痕）失败时主行是否同生共死：实测——是，整笔回滚且不留请求行', async () => {
      // V307 第二项：V306 只注入了第二步（审批联动）。这里注入**第三步** `recordAudit → appendAuditLog`
      // （该方法没有 try/catch，抛错会经 :513 的 catch 走 throwPersistence ⇒ 500）。
      // 要判的问题只有一个：留痕与主行是不是同一笔事务——若不是，就会出现"请求成立但查不到留痕"的审计缺口。
      const key = `bs-atm-${runId}`;
      const okKey = `bs-atmok-${runId}`;
      const { ControlService } = await import('../../server/modules/control/control.service');
      const svc = handle.app.get(ControlService) as unknown as {
        auditService?: { appendAuditLog: (entry: unknown) => Promise<unknown> } | undefined,
      };
      const original = svc.auditService;
      // 正向半边：不注入时，请求行与留痕行必须**同时**存在（只有反向半边会漏掉"审计静默丢失"这一支）
      const ctlRes = await apiRequest<{ id?: string }>(
        handle.baseUrl, '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({ deviceId, commandKeys: ['resume'], idempotencyKey: okKey }),
        },
      );
      expect(ctlRes.status).toBe(201);
      const ctlAudit = await owner`SELECT count(*)::int AS n FROM public.ewoh_audit_log
                                   WHERE entity_type = 'control_request'
                                     AND after_json->>'idempotencyKey' = ${okKey}`;
      expect(Number((ctlAudit[0] as Record<string, unknown>).n)).toBeGreaterThan(0);
      try {
        svc.auditService = {
          async appendAuditLog() {
            throw new Error('injected: audit sink unavailable');
          },
        };
        const r = await apiRequest<Record<string, unknown>>(
          handle.baseUrl, '/api/control/requests',
          {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({ deviceId, commandKeys: ['resume'], idempotencyKey: key }),
          },
        );
        expect(r.status).toBeGreaterThanOrEqual(500);
        const rows = await owner`SELECT request_id AS "requestId" FROM public.ewoh_control_request
                                WHERE idempotency_key = ${key}`;
        expect(rows.length).toBe(0);
        const auditAfter = await owner`SELECT count(*)::int AS n FROM public.ewoh_audit_log
                                       WHERE after_json->>'idempotencyKey' = ${key}`;
        expect(Number((auditAfter[0] as Record<string, unknown>).n)).toBe(0);
        console.log('[ATM-01] 注入留痕失败 ⇒ 请求行与留痕行同时为 0；不注入时两者同时存在 ⇒ 同生共死');
      } finally {
        svc.auditService = original;
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE idempotency_key = ANY($1)`,
          [[key, okKey]]);
      }
    });

    it('RCHK-01 库层拒绝之后能不能恢复：回滚不留半行、同一请求随后仍可 CAS 推进、非法推进不改权威行', async () => {
      // 位点：V297 的 CHECK 让"非法状态写入"成为 ewoh_control_request 的新失败模式；本轮补的是**被拒之后**那半段。
      // 自造异常前提＝同一事务里先写合法行、再写一个词表外的值 ⇒ 23514 让整事务回滚。
      // 断权威事实三件：① 两个 request_id 都不在库里（无半应用形态）；② 随后同一张表仍能正常写入并按 CAS 推进到 approved；
      // ③ 再来一次非法推进被拒后，重读权威行仍是 approved（拒绝没把既有事实改掉）。
      const orgRows = await owner`SELECT org_id::text AS "orgId" FROM public.ewoh_organization
                                   WHERE org_id IS NOT NULL LIMIT 1`;
      expect(orgRows.length).toBeGreaterThan(0);
      const orgId = String((orgRows[0] as Record<string, unknown>).orgId);
      const stamp = `${runId}-rchk`;
      const okId = `${stamp}-ok`;
      const badId = `${stamp}-bad`;
      try {
        let rollbackCode = '事务没抛错';
        try {
          await owner.begin(async (tx) => {
            await tx`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, status, _created_at)
                      VALUES (${orgId}::uuid, ${okId}, 'AGV-RCHK', 'start', 'created', now())`;
            await tx`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, status, _created_at)
                      VALUES (${orgId}::uuid, ${badId}, 'AGV-RCHK', 'start', 'NOT-A-STATE', now())`;
          });
        } catch (e) {
          rollbackCode = String((e as { code?: string }).code ?? '');
        }
        expect(rollbackCode).toBe('23514');
        const half = await owner`SELECT count(*)::int AS n FROM public.ewoh_control_request
                                 WHERE request_id IN (${okId}, ${badId})`;
        expect(Number((half[0] as Record<string, unknown>).n)).toBe(0);
        // 被拒之后同一张表仍可正常写入并按 CAS 推进——这才叫恢复了，而不是"没坏"
        await owner`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, status, _created_at)
                      VALUES (${orgId}::uuid, ${okId}, 'AGV-RCHK', 'start', 'created', now())`;
        const [advanced] = await owner`UPDATE public.ewoh_control_request
                                          SET status = 'approved', _updated_at = now()
                                        WHERE request_id = ${okId} AND status = 'created'
                                        RETURNING status`;
        expect(advanced).toBeDefined();
        expect(String((advanced as Record<string, unknown>).status)).toBe('approved');
        let second = '第二次非法推进没抛错';
        try {
          await owner`UPDATE public.ewoh_control_request
                         SET status = 'NOT-A-STATE' WHERE request_id = ${okId}`;
        } catch (e) {
          second = String((e as { code?: string }).code ?? '');
        }
        expect(second).toBe('23514');
        const [still] = await owner`SELECT status FROM public.ewoh_control_request
                                    WHERE request_id = ${okId}`;
        expect(String((still as Record<string, unknown>).status)).toBe('approved');
      } finally {
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE request_id LIKE $1`,
          [`${stamp}%`]);
      }
    });

    it('ORPH-01 高危请求处于 pending_approval 而审批实例不存在时：闸门必须 fail-closed 拒下发，且不产生任何在飞命令', async () => {
      // 缺陷登记在 §5.3n9（D 桶：`control.service.ts` 带他人未提交改动，本轮不代改）。
      // 这里只钉**当前正确的安全性质**——所以它修好后仍然该绿：
      //   · createControlRequest 不是事务：请求行先落库、审批实例后建，中间失败就留下
      //     "pending_approval 但没有审批实例"的行（本用例直接构造该状态，比删审批链更贴近洞的形状）；
      //   · 审批闸门对这种行必须 409（`control.service.ts:747-751`），绝不静默放行；
      //   · 被拒后不得产生命令/attempt 行，请求状态不得被推进。
      // 刻意**不**断言"它永远不会被收敛"——那是缺陷本身（链上今天没有请求级收敛者），修好后会失效。
      const orgRows = await owner`SELECT org_id::text AS "orgId" FROM public.ewoh_organization
                                   WHERE org_id IS NOT NULL LIMIT 1`;
      expect(orgRows.length).toBeGreaterThan(0);
      const orgId = String((orgRows[0] as Record<string, unknown>).orgId);
      const stamp = `${runId}-orph`;
      const reqId = `ORPH-${stamp}`;
      try {
        await owner`INSERT INTO public.ewoh_control_request
                         (org_id, request_id, device_id, control_type, command_keys, status,
                          risk_level, _created_at)
                       VALUES (${orgId}::uuid, ${reqId}, ${'AGV-ORPH-' + runId}, 'device_command',
                               ${owner.json(['resume'])}, 'pending_approval', 'high', now())`;
        const denied = await apiRequest<Record<string, unknown>>(
          handle.baseUrl, `/api/control/requests/${reqId}/commands`,
          {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({ commandKey: 'resume', payload: {} }),
          },
        );
        expect(denied.status).toBe(409);
        const cmds = await owner`SELECT count(*)::int AS n FROM public.ewoh_control_command
                                 WHERE request_id = ${reqId}`;
        expect(Number((cmds[0] as Record<string, unknown>).n)).toBe(0);
        const [still] = await owner`SELECT status FROM public.ewoh_control_request WHERE request_id = ${reqId}`;
        expect(String((still as Record<string, unknown>).status)).toBe('pending_approval');
        // V304：撤销是这条孤儿的唯一出口——审批闸门只管下发（:747-751），不挡 revoke；
        // 所以风险等级是「无自动收敛、无人提示，但人工可救」，不是「永久卡住」（后者已被本次实测否证）。
        const revoked = await apiRequest<Record<string, unknown>>(
          handle.baseUrl, `/api/control/requests/${reqId}/revoke?action=revoke`,
          { method: 'POST', headers: jsonHeaders(adminToken) },
        );
        console.log(`[ORPH-01] 孤儿行撤销：status=${revoked.status} body=${JSON.stringify(revoked.body).slice(0, 120)}`);
        expect(revoked.status).toBe(201);   // 实测码（tmp/v304-revoke-probe.log：status=201、随后行状态 revoked）
        const [rescued] = await owner`SELECT status FROM public.ewoh_control_request WHERE request_id = ${reqId}`;
        expect(String((rescued as Record<string, unknown>).status)).toBe('revoked');
      } finally {
        await owner.unsafe(`DELETE FROM public.ewoh_control_command WHERE request_id = $1`, [reqId]);
        await owner.unsafe(`DELETE FROM public.ewoh_control_request WHERE request_id = $1`, [reqId]);
      }
    });
  },
);
