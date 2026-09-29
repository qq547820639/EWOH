/**
 * Task 15.2 fault-injection（e2e）：PostgreSQL 临时故障降级可观测性。
 *
 * 对运行中的 standalone API 的数据库后端连接执行 pg_terminate_backend，
 * 断言：
 *   1) 故障窗口内的请求返回结构化 5xx（Nest 全局异常过滤器 JSON error），绝不 hang；
 *   2) 下一请求自动恢复（连接池重连，返回非 5xx）；
 *   3) 恢复后调度链路功能完好。
 *
 * 运行前提：真实 PG。无运行时 DB（resolveE2EConfig 返回 null）时整包 SKIP。
 *
 * 为什么 standalone API 必须是**子进程**（2026-09-18）：
 *   用例注入的是进程级故障 —— 终止在飞事务的连接会命中 postgres@3.4.9 的
 *   write/close 竞态，驱动把 `TypeError: Cannot read properties of null
 *   (reading 'write')` 抛在裸 setImmediate 上（脱离任何 Promise 链）。
 *   生产形态由 server/main.ts bootstrap 安装的 installPgConnectionFaultGuard
   * 接管（进程存活、留痕，请求按 5xx 失败）。若应用与 jest 同进程，
 *   jest-circus 会在每个用例开始时摘掉真实 process 上的全部
 *   uncaughtException 监听器、只留自己的记账器（jestAdapter 传
 *   parentProcess: process），驱动竞态异常必然被记为用例失败 —— 测试环境内
 *   （副本 process）注册的任何 handler 都拦不住。子进程形态让该用例回到
 *   其文档写明的前提「对运行中的 standalone API 注入故障」，产品 R-4 兜底
 *   在真实 process 上按生产行为生效；断言集与原实现完全一致。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';
import { startE2EApp } from '../helpers/e2e-app';

const e2eConfig = resolveE2EConfig();
const describeOrSkip = e2eConfig ? describe : describe.skip;

/** 子进程 standalone API 句柄（与 startE2EApp 的 handle 同形的最小子集）。 */
interface StandaloneChild {
  baseUrl: string;
  databaseApplicationName: string;
  close(): Promise<void>;
  /** 真实崩溃：SIGKILL，不给进程优雅退出的机会（调度腿重启基线需要）。 */
  hardKill(): Promise<void>;
  /**
   * 崩溃见证（CRASH-01）：子进程 stderr 尾部与退出信息。
   *
   * 为什么需要它们：`stderrTail` 原本只在「就绪前早退／未就绪」两条路径上打印，于是
   * **服务中途**子进程消失这件事在结构上不可归因——测试只看到 `ECONNREFUSED`，
   * 分不清是被测进程自己退了（`[PgFaultGuard]` 判非连接类异常后按 Node 默认语义退出）
   * 还是被外部杀掉。`Logger.error` 实测写 stderr，证据本来就在流里，只是过去被丢掉。
   */
  stderrTail(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null; atMs: number } | null;
}

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * run 的终态词表（唯一一份）。V203 起它同时是**轮询出口条件**与**收尾断言**的判据：
 * 此前出口用的是「已离开 queued」，run 停在 running 时会被提前放行 ⇒ 把"仍在飞行"
 * 读成"已收敛"，收尾断言等于没等到东西（V170 量具把这类块判成 waitOnly 的成因就在这儿）。
 */
const TERMINAL = ['succeeded', 'failed'];

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等本租户的**自动**重排静默（S-03/S-05 用）。
 *
 * 为什么必须等：风暴守卫（replan-coordinator `evaluateStormGuard`）的去抖判据是
 * 「本 org 最近一条非 MANUAL run 的 `_created_at` 距今 < replanDebounceMs（默认 5s）」，
 * 并且 org 级 `pg_try_advisory_xact_lock` 在整个独立重排事务期间都被持有
 * ——run 行是在那条事务里插入的，未提交时对外不可见，所以只看时间会误判"已静默"。
 * 派工本身就会经桥接产生一条 TASK_UPDATED 自动重排，不等它就会把"本例要测的那条触发"
 * 合并掉（实测：完整 D 段 3 次里 2 次 run=0，outbox 留下一条 replan.suppressed）。
 * 那是 F-10 的成因，属于另一条断言链（见 S-05），不该混进"续作是否闭合 run"这一变量。
 */
async function quiesceAutomaticReplan(
  owner: OwnerSql,
  orgId: string,
  windowMs = 6_000,
): Promise<void> {
  /**
   * 守卫锁探针：真正"没有自动重排在进行中"只能问锁本身。只看 run 表会漏——
   * 独立事务里的 run 行在提交前对外不可见，于是"看起来已静默"而 org 级
   * `pg_try_advisory_xact_lock` 仍被在途那条重排占着（实测 F-10b：
   * `replan suppressed for org … (storm_guard_lock_busy)`；打开
   * EWOH_DB_REQUIRE_TX 后时序变慢，S-03 曾在 3/3 稳定之后因此再红一次）。
   * 加锁与解锁写在**同一条语句**里：postgres.js 可能把不同查询派到不同连接，
   * 拆两条会把会话级 advisory lock 泄漏在池里某条空闲连接上——那反而制造抑制。
   */
  const guardLockFree = async (): Promise<boolean> => {
    const [probe] = await owner`
      with p as (select hashtext(${`${orgId}:replan_guard`})::bigint as k),
           a as (select pg_try_advisory_lock(k) as ok, k from p)
      select a.ok, (case when a.ok then pg_advisory_unlock(a.k) else false end) as released
      from a`;
    return probe?.ok === true;
  };

  for (let attempt = 0; attempt < 30; attempt += 1) {
    // 三个条件：(a) 本租户没有**未闭合**的自动 run；(b) 最近一条自动 run 的
    // _created_at 已超出 debounce 窗口（守卫读的就是这一列）；(c) 守卫锁无人持有。
    const [state] = await owner`
      SELECT count(*) FILTER (WHERE status NOT IN ('succeeded','failed'))::int AS open_runs,
             coalesce(extract(epoch from (now() - max("_created_at"))), 9999)::float8 AS newest_age_s
      FROM ewoh_scheduling_run
      WHERE org_id::text = ${orgId} AND trigger_type <> 'MANUAL'`;
    const settled =
      Number(state?.open_runs ?? 0) === 0
      && Number(state?.newest_age_s ?? 9999) > windowMs / 1000;
    if (settled && (await guardLockFree())) return;
    await delay(1_000);
  }
}

/**
 * 以生产形态（dist/server/main.js bootstrap）拉起 standalone API 子进程。
 * 进程级 PgFaultGuard 由该入口自行安装（与部署一致），本函数只负责
 * env 装配、就绪等待与退出回收。
 */
async function startStandaloneChild(
  config: NonNullable<ReturnType<typeof resolveE2EConfig>>,
  simulatorOrgId: string,
): Promise<StandaloneChild> {
  const port = await freeTcpPort();
  const databaseApplicationName = `ewoh-e2e-${randomUUID().slice(0, 12)}`;
  const databaseUrl = new URL(config.runtimeDatabaseUrl);
  databaseUrl.searchParams.set('application_name', databaseApplicationName);

  const entry = path.resolve(__dirname, '../../dist/server/main.js');
  let stderrTail = '';
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null; atMs: number } | null = null;
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      EWOH_DEPLOY_TARGET: 'standalone',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl.toString(),
      JWT_SECRET: config.jwtSecret,
      REFRESH_TOKEN_EXPIRES_IN: config.refreshTokenExpiresIn,
      RATE_LIMIT_MAX: config.rateLimitMax,
      LOGIN_RATE_LIMIT_MAX: '10000',
      // 摄入网关 fail-closed（P1-INGEST-002）：与 startE2EApp 相同的测试侧装配。
      INGEST_API_KEY: 'e2e-ingest-key',
      INGEST_RATE_LIMIT: '100000',
      INGEST_INSECURE_DEV_MODE: 'true',
      EWOH_SIMULATOR_ORG_ID: simulatorOrgId,
      EWOH_SIMULATOR_DISABLED: '1',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // 16k 而不是 4k：崩溃归因要留下得下"最后一条 warn + 那条 error 的整段栈"。
    stderrTail = (stderrTail + chunk).slice(-16_000);
  });
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal, atMs: Date.now() };
  });

  const close = async (): Promise<void> => {
    if (child.exitCode != null || child.signalCode != null) {
      child.stderr?.destroy();
      return;
    }
    // Always await the same exit event, including after SIGKILL escalation.
    // Closing stdio prevents Jest from waiting on a detached child's pipe handles.
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
    if (!graceful) child.kill('SIGKILL');
    await exited;
    child.stderr?.destroy();
  };

  /** 真实崩溃：SIGKILL 不给优雅退出的机会；用于「进程在 run 执行中途死掉」的重启基线。 */
  const hardKill = async (): Promise<void> => {
    if (child.exitCode != null || child.signalCode != null) {
      child.stderr?.destroy();
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await Promise.race([exited, delay(5000)]);
    child.stderr?.destroy();
  };

  // 就绪等待：任意 HTTP 响应（含 404/503）即视为监听已建立。
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `standalone child exited early (code=${child.exitCode})\n${stderrTail}`,
      );
    }
    try {
      await fetch(`${baseUrl}/health/live`);
      return {
        baseUrl,
        databaseApplicationName,
        close,
        hardKill,
        stderrTail: () => stderrTail,
        exitInfo: () => exitInfo,
      };
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  await close();
  throw new Error(
    `standalone child did not become ready: ${String(lastError)}\n${stderrTail}`,
  );
}

describeOrSkip('PostgreSQL 临时故障（Task 15.2 fault-injection）', () => {
  let owner: OwnerSql;
  let fixture: E2EFixture;
  let handle: StandaloneChild;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    if (!e2eConfig) {
      return;
    }
    owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
    fixture = await createE2EFixture(owner);
    handle = await startStandaloneChild(e2eConfig, fixture.orgA.id);
    baseUrl = handle.baseUrl;
    const loginRes = await login(
      baseUrl,
      fixture.dispatcherA.username,
      fixture.dispatcherA.password,
    );
    expect(loginRes.status).toBe(201);
    token = loginRes.body.accessToken;
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (owner) {
      if (fixture) await cleanupE2EFixture(owner, fixture);
      await owner.end();
    }
  });

  function runRequest() {
    return apiRequest(baseUrl, '/api/scheduler/runs', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({
        strategy: 'scheduling_v2',
        trigger: 'TASK_UPDATED',
      }),
    });
  }

  it('终止应用 DB 后端连接 → 结构化 5xx（不 hang、不吞错）；下一请求自动恢复', async () => {
    // 基线：故障前请求成功（非 5xx）。
    const baseline = await runRequest();
    if (baseline.status >= 500) {
      // 基线 5xx 只报状态码等于不可归因（V198b 实测一次红只能看到 `<500 got 500`）：
      // 响应体与子进程 stderr 尾巴一起打出来，才分得清是应用抛错还是驱动/求解器超时。
      console.log(
        `[S-00/BASELINE-5XX] status=${baseline.status} body=${JSON.stringify(baseline.body ?? null).slice(0, 600)}`
        + `\n${handle.stderrTail().split('\n').filter((l) => /ERROR|Error|error/.test(l)).slice(-12).join('\n')}`,
      );
    }
    expect(baseline.status).toBeLessThan(500);

    const postgres = (await import('postgres')).default;
    // The runtime role is deliberately denied pg_signal_backend. Use the
    // explicitly configured audit owner to terminate only runtime connections
    // opened by this standalone app. The runtime role name follows the runtime
    // DATABASE_URL（ewoh_api 部署形态 / 本地 owner 直连形态均可），配合本实例
    // 唯一的 application_name 精确瞄准，绝不误伤其它会话。
    const runtimeUser = decodeURIComponent(
      new URL(e2eConfig!.runtimeDatabaseUrl).username,
    );
    const admin = postgres(e2eConfig!.ownerDatabaseUrl, { max: 1 });
    /**
     * 确证在飞（FLAKE-05 的修法）：终止前必须**观测到**该应用有后端正在执行语句
     * （`state='active'`），而不是 `delay(30)` 押注重叠。
     *
     * 为什么不是"等事务开着"或"等锁排队"（V195 两种都实测过并被否）：
     *  - `xact_start IS NOT NULL`：四轮 ×200 次采样零命中，失败现场里该应用会话全是
     *    `idle / xact=N`（`tmp/v195-run1.log:13`）⇒ 该端点没有显式 BEGIN 的长事务；
     *  - 表锁构造等待者：`LOCK TABLE ewoh_scheduling_run IN SHARE ROW EXCLUSIVE MODE`
     *    三秒内没出现任何未授予行，现场是 `idle/…/commit`（`tmp/v195-run3.log`）
     *    ⇒ 请求根本不写这张表，构造出来的锁不在这个请求的必经之路上。
     * 结论：这个端点的 DB 段就是"几条隐式语句、毫秒级"，能确证的只有"此刻有会话在执行语句"。
     * 于是把**重叠密度**拿在手上：并发打 K 条请求，边打边以 2ms 轮询 active 后端，
     * 看到几条杀几条——杀的就是本实例（application_name 唯一）当时的在飞语句。
     * 前提（确证到过 active）与结论（拿到结构化 5xx）分开断言：
     * 前者失效时报"窗口没构造出来"，不许读成"兜底没接管"。
     */
    async function activeBackends(): Promise<number[]> {
      const rows = await admin`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database()
           AND usename = ${runtimeUser}
           AND application_name = ${handle.databaseApplicationName}
           AND pid <> pg_backend_pid()
           AND state = 'active'
      `;
      return rows.map((r) => Number(r.pid));
    }
    /** 前提失效时的现场快照：报错里必须带"当时库里有哪些会话在干什么"。 */
    const snapshotBackends = async (): Promise<string> => {
      const rows = await admin`
        SELECT pid, state, wait_event_type, left(query, 60) AS q
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY pid LIMIT 8
      `;
      return rows
        .map((r) => `${r.usename ?? ''}${r.pid}:${r.state}/${r.wait_event_type ?? '-'}/${r.q}`)
        .join(' | ');
    };
    /**
     * 崩溃见证（CRASH-01）：子进程若在测试中途退了，把退出码与 stderr 尾部一起报出来。
     * `signal` 为空 = 不是本用例杀的（`close`/`hardKill` 都发信号），而是被测进程自己退的
     * —— R-4 兜底把"非连接类异常"按 Node 默认语义处理成退出，那一刻留下的栈就是归因依据。
     */
    const crashWitness = (): string | null => {
      const info = handle.exitInfo();
      if (!info) return null;
      return (
        `standalone 子进程已退出 code=${info.code} signal=${info.signal}` +
        '\n--- stderr 尾部 ---\n' +
        handle.stderrTail()
      );
    };
    try {
      // 反复终止应用后端连接（排除本测试进程），确保故障窗口内至少一个请求命中坏连接。
      // 先发起请求再终止：在飞窗口内其后端被终止 → 连接级故障 → 子进程内 R-4 兜底接管
      //（驱动 rollback 竞态），请求以结构化 5xx 失败。若先终止后请求，postgres.js 会静默
      // 重连（池重建），请求反而可能不受影响 —— 注入窗口必须与在飞请求重叠才可观测。
      const K = 2;
      let observed5xx = false;
      let confirmedInjections = 0;
      let unconfirmedAttempts = 0;
      for (let i = 0; i < 4 && !observed5xx; i++) {
        // 滚动在飞（V207 实测教训）：只发一批再去轮询时，请求常在两次 2ms 采样之间就返回了，
        // 于是 pg_stat_activity 里的 active 会话属于"已经不算这个请求"的后端——杀掉它，
        // 两个请求照样 201 回来。四轮全这么错过之后，报出来的却是 `observed5xx=false`
        //（=「降级没发生」），把**窗口没构造出来**伪装成了结论失效。
        // 现在轮询期间持续补请求，并且只有"杀的那一刻仍有请求未决"才算一次确证注入。
        type Resp = Awaited<ReturnType<typeof runRequest>>;
        const inFlight: Array<Promise<Resp | { status: number; body: null }>> = [];
        let pending = 0;
        let fired = 0;
        const fire = () => {
          // 补到 K 路并发为止（不是"有一个在飞就停"——那会把原有的 K=2 悄悄降成 1）
          if (pending >= K || fired >= 60) return;
          fired += 1;
          pending += 1;
          inFlight.push(runRequest().then((r) => { pending -= 1; return r; },
            () => { pending -= 1; return { status: 0, body: null } as never; }));
        };
        for (let j = 0; j < K; j += 1) fire();
        let pid: number | null = null;
        let probes = 0;
        let pendingAtKill = 0;
        for (probes = 0; probes < 600; probes += 1) {
          fire();
          const pids = await activeBackends();
          if (pids.length > 0 && pending > 0) {
            pid = pids[0];
            pendingAtKill = pending;
            await admin`SELECT pg_terminate_backend(${pid})`;
            break;
          }
          await new Promise((r) => setTimeout(r, 2));
        }
        if (pid === null) {
          // 一次都没观测到「有 active 后端且请求仍未决」⇒ 这一轮不构成注入证据。
          await Promise.all(inFlight.map((p) => p.catch(() => undefined)));
          unconfirmedAttempts += 1;
          continue;
        }
        const killRounds = probes + 1;
        confirmedInjections += 1;
        for (let j = 0; j < K; j += 1) fire();
        const settled = await Promise.all(
          inFlight.map((p) => p.then((r) => Number((r as { status: number }).status)).catch(() => 0)),
        );
        console.log(
          `[S-00] 确证在飞后终止 pid=${pid} probes=${killRounds}(×2ms) 杀时未决=${pendingAtKill} 共发=${fired} 状态=${settled.join(',')}`,
        );
        const degraded = settled.find((s) => s >= 500);
        if (degraded !== undefined) {
          observed5xx = true;
          const hit = await inFlight[settled.indexOf(degraded)];
          // 15.6：降级可观测 —— 结构化 JSON error（非 hang、非无痕成功）。
          expect(hit.body).toHaveProperty('error');
          expect(typeof (hit.body as { error: unknown }).error).toBe('object');
          const error = (
            hit.body as { error: { code?: string; message?: string } }
          ).error;
          expect(typeof error.code).toBe('string');
          expect(typeof error.message).toBe('string');
        }
      }
      // 把"兜底真的接管过"从**没红**升级成**有留痕**：`[PgFaultGuard]` 走 Logger.error ⇒ stderr，
      // 见证已经把它收进 stderrTail；没有这一行时"进程还活着"只说明这轮的故障没到进程顶层。
      const guardLines = handle
        .stderrTail()
        .split('\n')
        .filter((line) => line.includes('[PgFaultGuard]'))
        // 去掉 `[Nest] <pid> - <时间戳> ERROR [PgConnectionFault]` 这段定长前缀，
        // 否则截断会把 `kind=` 与接管计数切掉——那正是这行唯一要读的字段。
        .map((line) => (line.match(/\[PgFaultGuard\].*/) ?? [line])[0].slice(0, 200));
      console.log(
        `[S-00] 进程级兜底留痕 ${guardLines.length} 条` +
          (guardLines.length ? `：\n  ${guardLines.join('\n  ')}` : '（本轮故障未到达进程顶层，只走请求路径）'),
      );
      // 崩溃优先于时机：子进程没了就先说"进程级放大"，别让它伪装成"窗口没构造出来"。
      const witness = crashWitness();
      if (witness) {
        throw new Error(
          `[S-00/CRASH-01] 终止在飞后端之后 standalone 子进程整体消失（并发=${K}）——` +
            `既不是"窗口没构造出来"，也不是"兜底没接管成 5xx"，而是进程级放大：\n${witness}`,
        );
      }
      // 前提断言与结论断言分开判（V182/FLAKE-03 同一口径）：
      // "窗口没构造出来"要说成窗口没构造出来，不能混成"兜底没接管"。
      if (confirmedInjections === 0) {
        throw new Error(
          `三轮里一次都没观测到该应用有后端在执行语句（未确证 ${unconfirmedAttempts} 轮）` +
            '⇒ 故障窗口没构造出来。这不是"降级没发生"，而是观测前提失效：' +
            '检查 application_name 是否仍由句柄暴露、探针角色是否看得见该会话的 state。' +
            `现场：${await snapshotBackends()}`,
        );
      }
      expect(observed5xx).toBe(true);
    } finally {
      await admin.end();
    }
    // 恢复：不再终止连接，**轮询**到某次请求非 5xx 为止。
    // 改前的形状是 `setTimeout(500)` + 单次读——它分不清"池子还没重连上"与"池子永远连不上"，
    // 且那 500ms 就是一个运气常数（V182 轴 B 把它判成 fixed-settle 的正是这一类）。
    // 有界轮询把两件事一起解决：慢收敛不再假红，不收敛仍然红（超窗即失败）。
    let recovered = { status: 0 };
    const recoverDeadline = Date.now() + 20_000;
    let recoverAttempts = 0;
    do {
      await new Promise((r) => setTimeout(r, 500));
      recovered = await runRequest();
      recoverAttempts += 1;
    } while (recovered.status >= 500 && Date.now() < recoverDeadline);
    console.log(`[S-00/RECOVER] 尝试=${recoverAttempts} 末次状态=${recovered.status} 用时=${20_000 - Math.max(0, recoverDeadline - Date.now())}ms`);
    expect(recovered.status).toBeLessThan(500);
  }, 60_000);

  /**
   * 调度／重启（矩阵空格，本轮补测）。
   *
   * 想测的问题：run 记录以 `status='queued'` 落库（`trigger.service.ts:131-148`），
   * 执行完才闭合；如果进程在两步之间被杀，是否会留下一行**永不被认领**的 queued
   * （全仓没有任何位置查询 `status='queued'` 的 run 去认领它），或者留下半应用方案。
   *
   * 做法：给足工作量（40 个待派工任务）把执行段拉长，再用 SIGKILL 在 40/150/400/1000ms
   * 四个时刻杀掉后端，然后用**全新进程**重启并等待，断言两条不变量：
   *   1) 无半应用：任何已提交的 run 行都不允许「状态仍是 queued 却已带 plan_ids」；
   *   2) 重启不重复产出：每个 run 的 status 与 plan_ids 长度在重启前后完全一致。
   * 另加一条功效断言：至少一次 kill 必须真的落在请求在飞期间（5xx 或连接被掐断），
   * 否则本例什么都没测到——**主动失败，不允许安静绿灯**（沿用 D-01/E-01 的纪律）。
   *
   * 是否存在 durable queued 残留由日志 `[S-01]` 如实报告，不作为断言前提：
   * 实测倾向是「同步 HTTP 路径下 run 行与执行在同一事务里，崩溃即整体不留行」，
   * 该结论的适用范围见基线文档 §4.1/§5.4。
   */
  it('S-01 run 执行中途崩溃 → 崩溃原子性与重启不重复产出（并记录 durable queued 是否存在）', async () => {
    if (!e2eConfig) return;
    interface RunFact {
      status: string;
      plans: number;
    }
    const killDelays = [40, 150, 400, 1000];
    // 单个任务的启发式求解只要几十 ms，40ms 的 kill 也追不上 `queued → 闭合` 的窗口
    // （首轮实测 4 个 run 全部 succeeded、零残留）。求解范围是全租户待派工集合，
    // 因此这里先铺一批任务把 run 的执行段拉长，同时每次用不同 entityId 避开去抖。
    const backlog = 40;
    const entityIds: string[] = [];
    for (let i = 0; i < backlog; i += 1) {
      const seeded = await seedSchedulerFixture(owner, fixture.orgA.id);
      entityIds.push(seeded.taskId);
    }
    const observed = new Map<string, RunFact>();
    const stranded: string[] = [];
    const attempts: Array<{ killAfter: number; http: unknown; rows: number; statuses: string[] }> = [];

    async function readRunFacts(entityId: string): Promise<Map<string, RunFact>> {
      const rows = await owner`
        SELECT run_id, status, coalesce(jsonb_array_length(plan_ids), 0) AS plans
        FROM ewoh_scheduling_run
        WHERE org_id::text = ${fixture.orgA.id} AND trigger_entity_id = ${entityId}`;
      const out = new Map<string, RunFact>();
      for (const r of rows) out.set(String(r.run_id), {
        status: String(r.status),
        plans: Number(r.plans),
      });
      return out;
    }

    for (const [index, killAfter] of killDelays.entries()) {
      const entityId = entityIds[index % entityIds.length];
      const child = await startStandaloneChild(e2eConfig, fixture.orgA.id);
      const tok = await login(child.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password);
      expect(tok.status).toBe(201);
      const inFlight = apiRequest(child.baseUrl, '/api/scheduler/runs', {
        method: 'POST',
        headers: jsonHeaders(tok.body.accessToken),
        body: JSON.stringify({
          strategy: 'scheduling_v2',
          trigger: 'MANUAL',
          entityId,
        }),
      }).catch(() => null);
      await delay(killAfter);
      await child.hardKill();
      const response = await inFlight;

      const facts = await readRunFacts(entityId);
      attempts.push({
        killAfter,
        http: response?.status ?? 'no-response',
        rows: facts.size,
        statuses: [...facts.values()].map((f) => f.status),
      });
      for (const [runId, fact] of facts) {
        observed.set(runId, fact);
        if (fact.status === 'queued') stranded.push(runId);
      }
      await child.close();
    }

    const statusHistogram = [...observed.values()].reduce<Record<string, number>>((acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[S-01] backlog=${backlog} kill 延时=${killDelays.join('/')}ms `
      + `观测 run=${observed.size} queued 残留=${stranded.length} 状态分布=${JSON.stringify(statusHistogram)} `
      + `逐次=${JSON.stringify(attempts)}`,
    );

    // 功效：至少一次 kill 真的落在请求在飞期间（否则本例什么都没测）。
    const killLanded = attempts.some(
      (a) => a.http === 'no-response' || Number(a.http) >= 500,
    );
    expect(killLanded).toBe(true);

    // 不变量 1（无半应用）：任何已提交的 run 行都不允许「状态还是 queued 却已带方案」。
    for (const runId of stranded) {
      expect(observed.get(runId)!.plans).toBe(0);
    }

    const restarted = await startStandaloneChild(e2eConfig, fixture.orgA.id);
    await delay(3000);
    for (const [runId, before] of observed) {
      const rows = await owner`
        SELECT status, coalesce(jsonb_array_length(plan_ids), 0) AS plans
        FROM ewoh_scheduling_run WHERE run_id = ${runId}`;
      expect(rows.length).toBe(1);
      const after: RunFact = { status: String(rows[0].status), plans: Number(rows[0].plans) };
      // 重启既不推进也不重复产出：残留必须原样存在。
      expect(after).toEqual(before);
    }
    await restarted.close();
  }, 180_000);

  /**
   * RUN-01 取证：DEVICE_OFFLINE 自动重排是 **fire-and-forget**
   * （`ingest.service.ts:300/1347` → `fireDeviceOfflineReplan`，注释自陈「不 await，
   * 真机数据接入优先」）。
   *
   * 本例走过的三次误判都留在这里，因为它们记录的是「为什么会误判」：
   *   1) 以为「fire-and-forget 不在请求事务里」。实测恰恰相反——它**继承** ingest 请求的
   *      ALS store，而 `runInTransaction` 遇到已有 store 时加入同一事务且无 savepoint，
   *      于是响应返回后 continuation 挂在已结束的事务上（S-03/S-04 已因果确认并修复）。
   *   2) 把控制组单次 4s 读到的 queued 当成 durable queued。改为轮询到终态后，
   *      「在途」与「永不收敛」才是两个可区分的结论。
   *   3) 修复后控制组仍 queued，一度以为是新缺陷。真因是**本例的子进程跑 `dist/server/**`
   *      （tsc 逐文件产物，不是 bundle）**，而 dist 的构建时间早于修复 → 测的是旧代码。
   *      `scripts/chain-baseline/verify.sh` 因此改为默认重建（EWOH_SKIP_BUILD=1 才复用）。
   *
   * 判定口径（修复 + 重建之后）：
   *  - 控制组收敛 → 未崩溃路径不再有静默 queued；
   *  - kill 组若留下 queued 且重启后原样 → 这才是**归因于崩溃**的 durable queued，
   *    全仓无认领方、无 TTL ⇒ 需要 queued-run 租约/TTL 清扫器兜底。
   */
  it('S-02 DEVICE_OFFLINE 自动重排（fire-and-forget）的崩溃窗口：是否存在 durable queued', async () => {
    if (!e2eConfig) return;

    async function armDevice(tag: string): Promise<string> {
      const seeded = await seedSchedulerFixture(owner, fixture.orgA.id);
      const [dev] = await owner`SELECT device_id FROM ewoh_device WHERE id = ${seeded.deviceIds[0]}`;
      const businessId = String(dev.device_id);
      await owner.unsafe(
        `insert into public.ewoh_spatial_entity
           (org_id, entity_id, entity_type, name, source_type)
         values ($1::uuid, $2, 'device', $2, 'seed') on conflict do nothing`,
        [fixture.orgA.id, businessId],
      );
      void tag;
      return businessId;
    }

    async function postFaultFrame(child: StandaloneChild, deviceId: string, tag: string) {
      return apiRequest(child.baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-ingest-key': process.env.INGEST_API_KEY ?? 'e2e-ingest-key',
          'x-org-id': fixture.orgA.id,
        },
        body: JSON.stringify({
          entity_id: deviceId,
          device_id: deviceId,
          event_time: new Date().toISOString(),
          source_type: 'simulated',
          pose: { trunk_pitch_deg: 50, angular_velocity_dps: 12.3, joint_angles_deg: { left_knee: 45 } },
          load: { assist_level: 0.6, torque_nm: 18.5, cumulative_load_score: 0.85 },
          device: { battery_pct: 9, temperature_c: 44, fault_code: `E2E-S02-${tag}` },
          quality: { packet_loss_pct: 0, confidence: 0.9, status: 'good' },
          record_id: `s02-${tag}`,
          raw_ref: `RAW-S02-${tag}`,
        }),
      });
    }

    async function offlineRuns(): Promise<Array<{ runId: string; status: string; plans: number }>> {
      const rows = await owner`
        SELECT run_id, status, coalesce(jsonb_array_length(plan_ids), 0) AS plans
        FROM ewoh_scheduling_run
        WHERE org_id::text = ${fixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE'`;
      return rows.map((r) => ({
        runId: String(r.run_id),
        status: String(r.status),
        plans: Number(r.plans),
      }));
    }

    // 控制组：不杀进程，走完整条 fire-and-forget 路径，并等到收敛。
    // 单次快照读分不清「仍在飞行中」与「永不收敛」，必须轮询；同时本组子进程跑的是
    // dist/server/**，产品代码有改动时必须先重建（verify.sh 默认重建）。
    const controlChild = await startStandaloneChild(e2eConfig, fixture.orgA.id);
    const controlDevice = await armDevice('control');
    const controlResp = await postFaultFrame(controlChild, controlDevice, 'control');
    let controlRuns: Array<{ runId: string; status: string; plans: number }> = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(1000);
      controlRuns = await offlineRuns();
      if (controlRuns.length > 0 && controlRuns.every((r) => ['succeeded', 'failed'].includes(r.status))) break;
    }
    console.log(
      `[S-02] 控制组 ingest=${controlResp.status} accepted=${
        (controlResp.body as { accepted?: boolean })?.accepted
      } DEVICE_OFFLINE run=${controlRuns.length} 状态=${JSON.stringify(
        controlRuns.map((r) => r.status),
      )}`,
    );
    // 控制组不成立就说明本例没在测这条路径——直接失败，不给假结论。
    expect(controlRuns.length).toBeGreaterThan(0);
    // 不崩溃时这条路径必须自己收敛（RUN-01 修复后的形状；仍是 queued 即为未修复的缺陷）。
    expect(controlRuns.every((r) => ['succeeded', 'failed'].includes(r.status))).toBe(true);
    await controlChild.close();

    // kill 组：ingest 返回后立刻/延后杀进程。
    const seen = new Map<string, { status: string; plans: number }>();
    for (const killAfter of [0, 60, 200]) {
      const child = await startStandaloneChild(e2eConfig, fixture.orgA.id);
      const tag = `kill${killAfter}`;
      const deviceId = await armDevice(tag);
      const inFlight = postFaultFrame(child, deviceId, tag).catch(() => null);
      if (killAfter === 0) {
        // 先杀再看响应：ingest 可能根本没返回（fire-and-forget 的 continuation 也随之消失）。
        await child.hardKill();
        await inFlight;
      } else {
        await inFlight;
        await delay(killAfter);
        await child.hardKill();
      }
      for (const r of await offlineRuns()) {
        if (!seen.has(r.runId)) seen.set(r.runId, { status: r.status, plans: r.plans });
      }
      await child.close();
    }

    const newRows = [...seen.entries()].filter(
      ([runId]) => !controlRuns.some((c) => c.runId === runId),
    );
    const durableQueued = newRows.filter(([, fact]) => fact.status === 'queued');
    console.log(
      `[S-02] kill 组新增 run=${newRows.length} durable queued=${durableQueued.length} `
      + `状态=${JSON.stringify(newRows.map(([, f]) => f.status))}`,
    );

    // 不变量：出现 queued 时不得同时带方案（半应用形态）。
    for (const [, fact] of durableQueued) expect(fact.plans).toBe(0);

    // 重启后必须原样：既没人认领，也不重复产出。
    const afterRestart = await startStandaloneChild(e2eConfig, fixture.orgA.id);
    await delay(3000);
    const finalRows = await offlineRuns();
    for (const [runId, before] of newRows) {
      const now = finalRows.find((r) => r.runId === runId);
      expect(now).toBeDefined();
      expect({ status: now!.status, plans: now!.plans }).toEqual(before);
    }
    await afterRestart.close();
  }, 180_000);

  /**
   * S-03：给 DEVICE_OFFLINE 重排**真实的影响面**（先派工，再让被派工的设备报故障），
   * 看 run 会不会闭合。
   *
   * 动机（S-02 控制组的意外发现）：不杀进程时，ingest 触发的 DEVICE_OFFLINE run
   * 也停在 `queued`（0 方案、无 error/failure_reason，后端健康，≥20s 无变化，日志里
   * run 创建之后一片安静）。S-02 那组「kill 后仍有 durable queued」因此**不能归因于崩溃**。
   * 本例用「设备确已派工」来分开两种可能：
   *   A. 只要影响面为空就提前返回且不闭合 → 残留是 no-op 路径的缺陷；
   *   B. 有影响面也不闭合 → fire-and-forget 路径根本不负责闭合，级别更高。
   *
   * 裁决（2026-09-21）：B，且机制不是「忘了闭合」而是**事务被继承后已关闭**——
   * continuation join 到 ingest 请求那个已提交的 store 上（RUN-01，基线文档 §5.3g）。
   * 修复为 `handleTriggerDetached`；本例因此从「现状固化」转为「闭合 + 失败留痕」的强断言。
   */
  it('S-03 有派发事实时，DEVICE_OFFLINE 自动重排是否闭合 run', async () => {
    if (!e2eConfig) return;
    const localFixture = await createE2EFixture(owner);
    const resources = await seedSchedulerFixture(owner, localFixture.orgA.id);
    process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
    const app = await startE2EApp(e2eConfig, localFixture.orgA.id);
    try {
      const dispatcher = await login(app.baseUrl, localFixture.dispatcherA.username, localFixture.dispatcherA.password);
      const approver = await login(app.baseUrl, localFixture.approverA.username, localFixture.approverA.password);
      expect(dispatcher.status).toBe(201);
      expect(approver.status).toBe(201);

      const run = await apiRequest<{ plans: Array<{ planId: string; version: number; snapshotVersion: string; assignments: Array<{ deviceId?: string | null }> }> }>(
        app.baseUrl, '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcher.body.accessToken),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: resources.taskId }),
        },
      );
      expect(run.status).toBe(201);
      const plan = run.body.plans[0];
      const approved = await apiRequest(app.baseUrl, `/api/scheduler/plans/${plan.planId}/approve`, {
        method: 'POST',
        headers: jsonHeaders(approver.body.accessToken),
        body: JSON.stringify({ version: plan.version, snapshotVersion: plan.snapshotVersion }),
      });
      expect(approved.status).toBe(200);
      const dispatched = await apiRequest(app.baseUrl, `/api/scheduler/plans/${plan.planId}/dispatch`, {
        method: 'POST',
        headers: jsonHeaders(dispatcher.body.accessToken),
      });
      expect(dispatched.status).toBe(200);

      // 取本方案实际派工到的设备业务号（device_id），故障上行必须打在它身上。
      const [dev] = await owner`
        SELECT d.device_id
        FROM ewoh_scheduling_plan_assignment a
        JOIN ewoh_device d ON d.id::text = a.device_id::text AND d.org_id::text = a.org_id::text
        WHERE a.org_id::text = ${localFixture.orgA.id} AND a.plan_id = ${plan.planId}
          AND a.device_id IS NOT NULL
        LIMIT 1`;
      expect(dev).toBeDefined();
      const deviceId = String(dev.device_id);
      // 机器网关按 canonical identity 校验 entity_id 存在（实测拒绝原因：
      // `entity_id EXO-E2E-… 不存在`）→ 先补一条 device 空间实体。
      await owner.unsafe(
        `insert into public.ewoh_spatial_entity
           (org_id, entity_id, entity_type, name, source_type)
         values ($1::uuid, $2, 'device', $2, 'simulated') on conflict do nothing`,
        [localFixture.orgA.id, deviceId],
      );

      /**
       * 静默期：派工本身会经桥接产生 TASK_UPDATED 自动重排，会把紧随其后的
       * DEVICE_OFFLINE 合并掉（守卫去抖 + org 级锁横跨整个重排事务）。
       * 那是 F-10 的成因（S-05 专测），不是本例的变量——先静默，本例只测
       * 「ingest 的 fire-and-forget 续作是否闭合 run」这一个变量。
       *
       * EWOH_S03_NO_QUIESCE=1 是**因果对照开关**：F-10 修复前后各跑一次
       * （其余输入完全相同），用来证明"跨实体被合并"这一条确实被修掉了。
       */
      if (process.env.EWOH_S03_NO_QUIESCE !== '1') {
        await quiesceAutomaticReplan(owner, localFixture.orgA.id);
      }

      const ingested = await apiRequest<{ accepted?: boolean }>(app.baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-ingest-key': process.env.INGEST_API_KEY ?? 'e2e-ingest-key',
          'x-org-id': localFixture.orgA.id,
        },
        body: JSON.stringify({
          entity_id: deviceId,
          device_id: deviceId,
          event_time: new Date().toISOString(),
          source_type: 'simulated',
          pose: { trunk_pitch_deg: 50, angular_velocity_dps: 12.3, joint_angles_deg: { left_knee: 45 } },
          load: { assist_level: 0.6, torque_nm: 18.5, cumulative_load_score: 0.85 },
          device: { battery_pct: 9, temperature_c: 44, fault_code: 'E2E-S03-FAULT' },
          quality: { packet_loss_pct: 0, confidence: 0.9, status: 'good' },
          record_id: `s03-${deviceId}`,
          raw_ref: `RAW-S03-${deviceId}`,
        }),
      });
      expect(ingested.status).toBe(201);
      console.log(`[S-03] ingest 响应=${JSON.stringify(ingested.body).slice(0, 300)}`);
      expect(ingested.body?.accepted).toBe(true);

      let rows: Array<{ run_id: string; status: string; plans: number; error: string | null }> = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(1000);
        rows = await owner`
          SELECT run_id, status, coalesce(jsonb_array_length(plan_ids), 0) AS plans, error
          FROM ewoh_scheduling_run
          WHERE org_id::text = ${localFixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE'`;
        if (rows.length > 0 && rows.every((r) => TERMINAL.includes(r.status))) break;
      }
      console.log(
        `[S-03] 影响面=已派工设备 ${deviceId} DEVICE_OFFLINE run=${rows.length} `
        + `状态=${JSON.stringify(rows.map((r) => ({ s: r.status, plans: r.plans })))}`,
      );
      // 诊断（仅 run=0 时采集，2026-09-22）：本例在完整 D 段出现过一次 run=0、
      // 单独跑与 S-0[234] 顺序跑都稳定 run=1。"没有 run"至少有五种互斥成因
      // （转换判定没通过 / 守卫 debounce / 守卫 suppress（advisory lock 撞锁或窗口配额）/
      // guard fail-closed / 独立事务本身失败），必须一次跑就能分出是哪一种。
      if (rows.length === 0) {
        const dev = await owner`
          SELECT device_id, online, fault_code, last_telemetry_at
          FROM ewoh_device
          WHERE org_id::text = ${localFixture.orgA.id} AND device_id = ${deviceId}`;
        const runsAnyType = await owner`
          SELECT run_id, status, trigger_type, trigger_entity_id, error
          FROM ewoh_scheduling_run
          WHERE org_id::text = ${localFixture.orgA.id}`;
        const trig = await owner`
          SELECT trigger_key, trigger_type, status, run_id, entity_id
          FROM ewoh_replan_trigger
          WHERE org_id::text = ${localFixture.orgA.id}`;
        const obx = await owner`
          SELECT event_type, entity_id, created_at FROM ewoh_outbox
          WHERE org_id::text = ${localFixture.orgA.id} AND event_type LIKE 'replan%'`;
        const conns = await owner`
          SELECT count(*)::int AS used, current_setting('max_connections')::int AS max
          FROM pg_stat_activity WHERE datname = current_database()`;
        console.log(
          `[S-03] 诊断 device=${JSON.stringify(dev)} run(本租户全类型)=${JSON.stringify(runsAnyType)} `
          + `trigger=${JSON.stringify(trig)} outbox=${JSON.stringify(obx)} `
          + `conns=${JSON.stringify(conns)}`,
        );
      }
      // 本例的判定口径：自动重排必须把 run 闭合（终态），否则就是「永不收敛」的第二例。
      expect(rows.length).toBeGreaterThan(0);
      // RUN-01 已修复（2026-09-21 实测翻转本行）：ingest 的 fire-and-forget  continuation
      // 原先 join 到「已结束」的请求事务上 → run 永停 queued、无方案、无留痕、无日志。
      // 修复后走 handleTriggerDetached（独立事务 + GUC），首轮轮询即 `succeeded` + 3 条方案。
      expect(rows.every((r) => TERMINAL.includes(r.status))).toBe(true);
      // 失败也必须留痕：closed-as-failed 是允许的形状，静默失败不是。
      for (const r of rows) {
        if (r.status === 'failed') expect(r.error).toBeTruthy();
      }
    } finally {
      await app.close();
      await cleanupE2EFixture(owner, localFixture);
    }
  }, 180_000);

  /**
   * S-04：任务写路径（TASK_CREATED）的 fire-and-forget 重排是否与 S-03 同形。
   *
   * 为什么要单独测：`task-scheduling.bridge.ts:42-50` 是**第二个**不 await 的重排调用点，
   * 与 ingest 的 `fireDeviceOfflineReplan` 形状相同（在请求事务内启动、响应返回后继续跑）。
   * 但"形状相同"不等于"结论相同"——冷却/去抖/审批 consult 与级联路径都在
   * `injectSchedulingEvent` 里多了一层，机制必须自己复现一遍才允许写进基线。
   */
  it('S-04 任务创建桥接的自动重排是否闭合 run', async () => {
    if (!e2eConfig) return;
    const localFixture = await createE2EFixture(owner);
    await seedSchedulerFixture(owner, localFixture.orgA.id);
    process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
    const app = await startE2EApp(e2eConfig, localFixture.orgA.id);
    try {
      const dispatcher = await login(app.baseUrl, localFixture.dispatcherA.username, localFixture.dispatcherA.password);
      expect(dispatcher.status).toBe(201);

      const created = await apiRequest<{ id?: string; taskId?: string }>(
        app.baseUrl, '/api/tasks',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcher.body.accessToken),
          body: JSON.stringify({
            title: `S-04 桥接闭合探针 ${Date.now()}`,
            taskType: 'assembly',
            priority: 'low',
          }),
        },
      );
      expect(created.status).toBe(201);
      const taskId = created.body?.id ?? created.body?.taskId ?? null;
      expect(taskId).toBeTruthy();

      let rows: Array<{ run_id: string; status: string; plans: number; error: string | null }> = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(1000);
        rows = await owner`
          SELECT run_id, status, coalesce(jsonb_array_length(plan_ids), 0) AS plans, error
          FROM ewoh_scheduling_run
          WHERE org_id::text = ${localFixture.orgA.id}
            AND trigger_type IN ('TASK_CREATED', 'TASK_UPDATED')`;
        if (rows.length > 0 && rows.every((r) => TERMINAL.includes(r.status))) break;
      }
      console.log(
        `[S-04] 任务写路径 task=${taskId} 桥接 run=${rows.length} `
        + `状态=${JSON.stringify(rows.map((r) => ({ s: r.status, plans: r.plans })))}`,
      );
      // 诊断（仅在 run=0 时采集）：区分「桥接没触发」「触发了但被政策/守卫拦下」
      // 与「触发了、创建了 run 但不闭合」三种完全不同的结论。
      if (rows.length === 0) {
        const runsAnyOrg = await owner`
          SELECT run_id, org_id, status, trigger_type, trigger_entity_id
          FROM ewoh_scheduling_run
          WHERE trigger_type IN ('TASK_CREATED', 'TASK_UPDATED')`;
        const trig = await owner`
          SELECT trigger_key, org_id, status, run_id, entity_id
          FROM ewoh_replan_trigger
          WHERE trigger_type IN ('TASK_CREATED', 'TASK_UPDATED')`;
        const obx = await owner`
          SELECT event_type, entity_id, org_id FROM ewoh_outbox
          WHERE event_type LIKE 'replan%'`;
        console.log(
          `[S-04] 诊断 run(任意租户)=${JSON.stringify(runsAnyOrg)} `
          + `trigger=${JSON.stringify(trig)} outbox=${JSON.stringify(obx)}`,
        );
      }
      // 前置条件：桥接确实把事件变成了 run。没有 run 就说明本例没在测这条路径。
      expect(rows.length).toBeGreaterThan(0);
      // RUN-01 同形缺陷在桥接侧的**因果确认**（2026-09-21）：只改「续作是否自带事务」
      // 这一个变量，其余输入完全相同 ——
      //   修复前：run=0 trigger=0 outbox=0 且无任何日志（静默丢失，测不出、看不出）；
      //   修复后：首轮轮询即 run=1 状态=succeeded plans=3。
      // 因此本例钉成「闭合 + 失败留痕」，而不是固化当时的 0 行现状。
      expect(rows.every((r) => TERMINAL.includes(r.status))).toBe(true);
      for (const r of rows) {
        if (r.status === 'failed') expect(r.error).toBeTruthy();
      }
    } finally {
      await app.close();
      await cleanupE2EFixture(owner, localFixture);
    }
  }, 180_000);

  /**
   * S-05（F-10 现状钉住，2026-09-22 实测）：去抖窗口内的**第二个**电平触发重排需求
   * 被合并掉之后，系统里既没有 run，也没有任何可补投的持久记号。
   *
   * 发现路径：完整 D 段里 S-03 偶发 run=0（3 次里 2 次）。给 S-03 加了 run=0 诊断后
   * 抓到 `ewoh_outbox` 里一条 `replan.suppressed` —— 触发到了、守卫把它合掉了。
   *
   * 为什么用"恢复 → 再故障"而不是"两台设备同时故障"：本例要测的是守卫的**去抖判据**，
   * 与设备数量无关；同一台设备翻转不需要夹具再产出第二个已派工设备，因此是确定性的。
   * （锁相撞那条路径由单测 replan-storm「F-10：守卫锁被占用」钉住。）
   *
   * ⚠ 本例断言的是**当前行为**，不是应有行为：修 F-10 时必须连同本例一起改成
   * 「第二个需求要么产生 run，要么留下可被补投的持久记号」。
   */
  it('S-05 去抖窗口内的第二次设备故障：既无 run 也无任何持久记号（F-10 现状）', async () => {
    if (!e2eConfig) return;
    const localFixture = await createE2EFixture(owner);
    const resources = await seedSchedulerFixture(owner, localFixture.orgA.id);
    process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
    const app = await startE2EApp(e2eConfig, localFixture.orgA.id);

    const faultFrame = (deviceId: string, recordId: string, faultCode: string) => JSON.stringify({
      entity_id: deviceId,
      device_id: deviceId,
      event_time: new Date().toISOString(),
      source_type: 'simulated',
      pose: { trunk_pitch_deg: 50, angular_velocity_dps: 12.3, joint_angles_deg: { left_knee: 45 } },
      load: { assist_level: 0.6, torque_nm: 18.5, cumulative_load_score: 0.85 },
      device: { battery_pct: 9, temperature_c: 44, fault_code: faultCode },
      quality: { packet_loss_pct: 0, confidence: 0.9, status: 'good' },
      record_id: recordId,
      raw_ref: `RAW-${recordId}`,
    });
    const countOfflineRuns = async (): Promise<number> => {
      const [row] = await owner`
        SELECT count(*)::int AS n FROM ewoh_scheduling_run
        WHERE org_id::text = ${localFixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE'`;
      return Number(row?.n ?? 0);
    };

    try {
      const dispatcher = await login(app.baseUrl, localFixture.dispatcherA.username, localFixture.dispatcherA.password);
      const approver = await login(app.baseUrl, localFixture.approverA.username, localFixture.approverA.password);
      const run = await apiRequest<{ plans: Array<{ planId: string; version: number; snapshotVersion: string }> }>(
        app.baseUrl, '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcher.body.accessToken),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: resources.taskId }),
        },
      );
      expect(run.status).toBe(201);
      const plan = run.body.plans[0];
      const approved = await apiRequest(app.baseUrl, `/api/scheduler/plans/${plan.planId}/approve`, {
        method: 'POST',
        headers: jsonHeaders(approver.body.accessToken),
        body: JSON.stringify({ version: plan.version, snapshotVersion: plan.snapshotVersion }),
      });
      expect(approved.status).toBe(200);
      const dispatched = await apiRequest(app.baseUrl, `/api/scheduler/plans/${plan.planId}/dispatch`, {
        method: 'POST',
        headers: jsonHeaders(dispatcher.body.accessToken),
      });
      expect(dispatched.status).toBe(200);

      const [dev] = await owner`
        SELECT d.device_id
        FROM ewoh_scheduling_plan_assignment a
        JOIN ewoh_device d ON d.id::text = a.device_id::text AND d.org_id::text = a.org_id::text
        WHERE a.org_id::text = ${localFixture.orgA.id} AND a.plan_id = ${plan.planId}
          AND a.device_id IS NOT NULL
        LIMIT 1`;
      expect(dev).toBeDefined();
      const deviceId = String(dev.device_id);
      await owner.unsafe(
        `insert into public.ewoh_spatial_entity
           (org_id, entity_id, entity_type, name, source_type)
         values ($1::uuid, $2, 'device', $2, 'simulated') on conflict do nothing`,
        [localFixture.orgA.id, deviceId],
      );

      // ① 第一次故障：先静默，确保它不被派工自己产生的自动重排合并（那是 F-10，不是本步要测的）。
      await quiesceAutomaticReplan(owner, localFixture.orgA.id);
      const firstIngest = await apiRequest<{ accepted?: boolean }>(app.baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-ingest-key': process.env.INGEST_API_KEY ?? 'e2e-ingest-key',
          'x-org-id': localFixture.orgA.id,
        },
        body: faultFrame(deviceId, `s05a-${deviceId}`, 'E2E-S05-FAULT-A'),
      });
      expect(firstIngest.status).toBe(201);
      let firstRuns = 0;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(1000);
        const rows = await owner`
          SELECT status FROM ewoh_scheduling_run
          WHERE org_id::text = ${localFixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE'`;
        if (rows.length > 0 && rows.every((r) => r.status !== 'queued')) {
          firstRuns = rows.length;
          break;
        }
      }
      // 前置事实：第一次故障确实换来了一个闭合的 run（否则下一步的"没有新 run"毫无意义）。
      expect(firstRuns).toBeGreaterThan(0);

      // ② 设备恢复 → 再故障：世界状态确实又变了一次（电平触发的第二个需求），
      //    但它落在第一次 run 的去抖窗口里。
      //    窗口判据是「最近一条非 MANUAL run 的 `_created_at` 距今 < replanDebounceMs」，
      //    所以把该时间钉到"刚刚"，让第二个需求**确定性地**落在窗口内——
      //    本例要测的是窗口内的合并语义，不是撞时序概率。
      await owner.unsafe(
        `update public.ewoh_scheduling_run set "_created_at" = now()
         where org_id::text = $1 and trigger_type = 'DEVICE_OFFLINE'`,
        [localFixture.orgA.id],
      );
      await owner.unsafe(
        `update public.ewoh_device set fault_code = null, online = true
         where org_id::text = $1 and device_id = $2`,
        [localFixture.orgA.id, deviceId],
      );
      const secondIngest = await apiRequest<{ accepted?: boolean }>(app.baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-ingest-key': process.env.INGEST_API_KEY ?? 'e2e-ingest-key',
          'x-org-id': localFixture.orgA.id,
        },
        body: faultFrame(deviceId, `s05b-${deviceId}`, 'E2E-S05-FAULT-B'),
      });
      expect(secondIngest.status).toBe(201);
      expect(secondIngest.body?.accepted).toBe(true);

      let secondRuns = firstRuns;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await delay(1000);
        secondRuns = await countOfflineRuns();
        if (secondRuns > firstRuns) break;
      }

      // ③ 现状：run 计数不变（需求被合并），而且库里没有任何"待补投"的痕迹——
      //    去抖连 `replan.suppressed` 都不发（抑制才发，去抖不发），所以事后无从发现。
      const obx = await owner`
        SELECT event_type, entity_id FROM ewoh_outbox
        WHERE org_id::text = ${localFixture.orgA.id} AND event_type LIKE 'replan%'`;
      const stranded = await owner`
        SELECT count(*)::int AS n
        FROM ewoh_scheduling_plan_assignment a
        JOIN ewoh_device d ON d.id::text = a.device_id::text
        WHERE a.org_id::text = ${localFixture.orgA.id} AND d.fault_code IS NOT NULL`;
      console.log(
        `[S-05] 第二次故障 run 增量=${secondRuns - firstRuns}（首次=${firstRuns}） `
        + `outbox(replan*)=${JSON.stringify(obx)} 故障设备仍持有分配=${JSON.stringify(stranded)}`,
      );
      expect(secondRuns).toBe(firstRuns);
      // 「被抑制」至少还有 outbox 事件；「被去抖」今天**连事件都没有**——这就是 F-10 的
      // 可观测半边：事后无法从数据面区分"合并掉了"和"根本没触发"。
      expect(obx.some((r) => r.event_type === 'replan.suppressed')).toBe(false);
      expect(obx.some((r) => r.event_type === 'replan.debounced')).toBe(false);
      // 业务后果可核验：设备带着未处理的故障码仍持有派工分配，且没有为这次故障产出任何候选方案。
      expect(Number(stranded[0]?.n ?? 0)).toBeGreaterThan(0);
    } finally {
      await app.close();
      await cleanupE2EFixture(owner, localFixture);
    }
  }, 180_000);

  /**
   * S-06（F-10 修复的正向对照，与 S-05 同形只差"实体是否相同"）：
   * 同租户里 `TASK_CREATED(taskA)` 的重排刚闭合，紧接着另一个工作项
   * `DEVICE_OFFLINE(deviceB)` 的故障上行必须仍然换来自己的 run。
   *
   * 修复前去抖按**租户**判（读的是"本 org 最近一条非 MANUAL run"）→ 第二个需求被判
   * "5s 内刚重排过"而丢弃，且不产生任何可补投的记号；修复后按**触发实体**判，
   * 配额仍按租户（风暴负载上界不变）。单测同族三条（replan-storm）给出红→绿，
   * 本例给真实 Nest + 真实 PostgreSQL 的形状。
   *
   * 窗口是钉住的：把 taskA 那条 run 的 `_created_at` 改成 `now()`，让"落在去抖窗口内"
   * 成为受控前提——否则本例测的是竞态概率，不是判据本身。
   */
  it('S-06 去抖窗口内的另一个工作项不再被合并（F-10 修复对照）', async () => {
    if (!e2eConfig) return;
    const localFixture = await createE2EFixture(owner);
    const resources = await seedSchedulerFixture(owner, localFixture.orgA.id);
    process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
    const app = await startE2EApp(e2eConfig, localFixture.orgA.id);
    try {
      const dispatcher = await login(app.baseUrl, localFixture.dispatcherA.username, localFixture.dispatcherA.password);
      expect(dispatcher.status).toBe(201);

      // ① 工作项一：任务创建 → TASK_CREATED 自动重排（实体 = taskId）
      const created = await apiRequest<{ id?: string; taskId?: string }>(app.baseUrl, '/api/tasks', {
        method: 'POST',
        headers: jsonHeaders(dispatcher.body.accessToken),
        body: JSON.stringify({
          title: `S-06 跨实体工作项一 ${Date.now()}`,
          taskType: 'assembly',
          priority: 'low',
        }),
      });
      expect(created.status).toBe(201);
      const firstTaskId = created.body?.id ?? created.body?.taskId ?? null;
      expect(firstTaskId).toBeTruthy();

      let firstClosed = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(1000);
        const rows = await owner`
          SELECT status FROM ewoh_scheduling_run
          WHERE org_id::text = ${localFixture.orgA.id}
            AND trigger_type IN ('TASK_CREATED','TASK_UPDATED')`;
        if (rows.length > 0 && rows.every((r) => r.status !== 'queued')) {
          firstClosed = true;
          break;
        }
      }
      expect(firstClosed).toBe(true);

      // ② 把工作项一的 run 时间钉到"刚刚"：让第二次触发确定性地落在去抖窗口内
      await owner.unsafe(
        `update public.ewoh_scheduling_run set "_created_at" = now()
         where org_id::text = $1`,
        [localFixture.orgA.id],
      );

      // ③ 工作项二：另一台设备正常 → 故障（实体 = deviceId，与工作项一无关）
      const [dev] = await owner`
        select device_id from public.ewoh_device
        where org_id::text = ${localFixture.orgA.id}
        order by device_id limit 1`;
      expect(dev).toBeDefined();
      const deviceId = String(dev.device_id);
      await owner.unsafe(
        `update public.ewoh_device set fault_code = null, online = true
         where org_id::text = $1 and device_id = $2`,
        [localFixture.orgA.id, deviceId],
      );
      await owner.unsafe(
        `insert into public.ewoh_spatial_entity
           (org_id, entity_id, entity_type, name, source_type)
         values ($1::uuid, $2, 'device', $2, 'simulated') on conflict do nothing`,
        [localFixture.orgA.id, deviceId],
      );
      const ingested = await apiRequest<{ accepted?: boolean }>(app.baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-ingest-key': process.env.INGEST_API_KEY ?? 'e2e-ingest-key',
          'x-org-id': localFixture.orgA.id,
        },
        body: JSON.stringify({
          entity_id: deviceId,
          device_id: deviceId,
          event_time: new Date().toISOString(),
          source_type: 'simulated',
          pose: { trunk_pitch_deg: 50, angular_velocity_dps: 12.3, joint_angles_deg: { left_knee: 45 } },
          load: { assist_level: 0.6, torque_nm: 18.5, cumulative_load_score: 0.85 },
          device: { battery_pct: 9, temperature_c: 44, fault_code: 'E2E-S06-FAULT' },
          quality: { packet_loss_pct: 0, confidence: 0.9, status: 'good' },
          record_id: `s06-${deviceId}`,
          raw_ref: `RAW-S06-${deviceId}`,
        }),
      });
      expect(ingested.status).toBe(201);

      let second: Array<{ run_id: string; status: string; entity: string | null }> = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(1000);
        second = await owner`
          SELECT run_id, status, trigger_entity_id AS entity FROM ewoh_scheduling_run
          WHERE org_id::text = ${localFixture.orgA.id} AND trigger_type = 'DEVICE_OFFLINE'`;
        if (second.length > 0 && second.every((r) => TERMINAL.includes(r.status))) break;
      }
      const obx = await owner`
        SELECT event_type FROM ewoh_outbox
        WHERE org_id::text = ${localFixture.orgA.id}
          AND event_type IN ('replan.suppressed','replan.debounced')`;
      console.log(
        `[S-06] 工作项一 task=${firstTaskId} 已闭合；工作项二 device=${deviceId} `
        + `DEVICE_OFFLINE run=${JSON.stringify(second)} 抑制事件=${JSON.stringify(obx)}`,
      );
      // 判据本身：另一个工作项照旧重排，且没有被"合并"掉
      expect(second.length).toBeGreaterThan(0);
      expect(second.every((r) => TERMINAL.includes(r.status))).toBe(true);
      expect(second.every((r) => r.entity === deviceId)).toBe(true);
      expect(obx.length).toBe(0);
    } finally {
      await app.close();
      await cleanupE2EFixture(owner, localFixture);
    }
  }, 180_000);
});
