/**
 * 试点链行为基线：派工 × 回执 **重叠事务**（真实 Nest + 真实 PostgreSQL）。
 *
 * 动机（§3.4）：派工与回执两条写路径都改同一批 plan/task/assignment 行，
 * 走读只能得出「加锁次序一致、路径枚举下未见反转」——那是**推断级**结论。
 * 死锁只有在真实重叠下才有资格写「未观察到」，因此本文件做实测：
 * 同一个已批准方案上，派工事务与多条回执事务同时发起，重复若干轮。
 *
 * 两条自我约束：
 *  1. **功效断言**：先从 `pg_stat_activity`（按本测试后端的 application_name）测出
 *     峰值并发活动会话数，要求 ≥2。测不出重叠的实验没有资格声明「无死锁」，
 *     所以让它直接失败，而不是安静地通过。
 *  2. **判定口径**：死锁/取消在 Nest 侧表现为 5xx（PostgreSQL 40P01 / 25006 等），
 *     故断言「无 5xx 且响应体不含死锁/中止字样」；4xx 是合法的竞态裁决
 *     （回执早于派工提交必然 409），不算失败，但终态不变量必须成立。
 *
 * 本文件只观测既有行为，不改产品代码。
 */
import type { SchedulingPlanV2 } from '../../shared/api.interface';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { load } from 'js-yaml';
import postgres from 'postgres';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
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
const ROUNDS = 8;

/** 与响应体一起比对前先统一小写；含 PostgreSQL 死锁/序列化中止/锁超时的错误码与措辞。 */
const DEADLOCK_MARKERS = [
  'deadlock',
  '40p01',
  '25006',
  '55p03',
  'could not serialize',
  'concurrent update',
  'lock timeout',
];

/**
 * 回执那道状态守卫的允许集（`execution-receipt-application.service.ts:91` 的 `includes` 列表，逐字同步）。
 * E-02 用它当"派工前态"的反向判据：派工前那一态必须**不在**这里，否则 B 支的"据新版本拒绝"
 * 根本没有可拒绝的态可退——写死 'approved' 会在词表变更时假绿，故从守卫处取集合再求补。
 */
const RECEIPT_GUARD_ALLOWED = ['dispatched', 'executing', 'completed', 'failed', 'cancelled'];

/**
 * PCND-01（V328）：WAVE-01 那一支的**判据来源**。表名／列名／状态取值／父行迁移两端
 * 一律从 `contracts/state-machines/plan.yaml` 的 `wave_completion` 块组装，测试自己不再写死
 * ——写死就是"在测试里重抄实现的 WHERE"，改契约不会有人报警。
 * 两条纪律（沿用同仓 `feedback_projection`／KPI 窗口块那两处的做法）：
 *  1. 读不到块就抛，不许静默退回字面值（退回就等于判据又回到测试里）；
 *  2. 标识符先验形状（`^[a-z_][a-z0-9_]*$`）再拼进 SQL，**值**一律走 `$n` 参数位。
 */
const WAVE_CONTRACT_PATH = resolvePath(__dirname, '../../../contracts/state-machines/plan.yaml');
interface WaveCompletionContract {
  parent_table: string;
  parent_key: string;
  parent_status_column: string;
  child_table: string;
  child_key: string;
  child_parent_key: string;
  child_status_column: string;
  tenant_column: string;
  pending_status: string;
  from_status: string;
  to_status: string;
  pending_count_sql: string;
  parent_status_sql: string;
  response_field: string;
  response_ids_field: string;
  response_dispatched_field: string;
}
function waveCompletion(): WaveCompletionContract {
  const doc = load(readFileSync(WAVE_CONTRACT_PATH, 'utf8')) as { wave_completion?: WaveCompletionContract };
  if (!doc?.wave_completion) {
    throw new Error(`契约里读不到 wave_completion（${WAVE_CONTRACT_PATH}）⇒ 波次判据无从组装`);
  }
  return doc.wave_completion;
}
const WC = waveCompletion();
const IDENT = /^[a-z_][a-z0-9_]*$/;
/** 契约字段当作 SQL 片段用之前的形状闸：形状不对就是契约被改坏，不是"用例该跳"。 */
function ident(field: keyof WaveCompletionContract): string {
  const v = String(WC[field]);
  if (!IDENT.test(v)) {
    throw new Error(`wave_completion.${field} 不是可拼进 SQL 的标识符：${JSON.stringify(v)}`);
  }
  return v;
}
/** 把 `{child_table}` 这类占位换成契约里的标识符（值不在此列——值走参数位）。 */
function expandContractSql(tpl: string): string {
  return tpl.replace(/\{([a-z_]+)\}/g, (_m, key: string) => {
    if (!(key in WC)) throw new Error(`wave_completion 模板引用了不存在的字段 {${key}}`);
    return ident(key as keyof WaveCompletionContract);
  });
}

(config ? describe : describe.skip)(
  '派工×回执重叠基线 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let dispatcherToken = '';
    let approverToken = '';

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const dispatcher = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      dispatcherToken = dispatcher.body.accessToken;
      const approver = await login(
        handle.baseUrl,
        fixture.approverA.username,
        fixture.approverA.password,
      );
      expect(approver.status).toBe(201);
      approverToken = approver.body.accessToken;
    }, 120_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    /** 本测试后端的活跃会话峰值——重叠是否真的发生过，只能这么证明。 */
    async function activeBackendCount(): Promise<number> {
      const rows = await owner`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = ${handle.databaseApplicationName} AND state = 'active'`;
      return Number(rows[0]?.n ?? 0);
    }

    /** 权威列读数：withFacts=false 只读 assignment，true 再并上 task 与 execution 的收尾事实。 */
    async function readStates(planId: string, withFacts: boolean): Promise<Array<Record<string, unknown>>> {
      return (await owner.unsafe(
        withFacts
          ? `SELECT a.assignment_id AS id, a.status AS a_status, t.status AS t_status, e.actual_end_at AS end_at
               FROM ewoh_scheduling_plan_assignment a
               LEFT JOIN ewoh_production_task t
                 ON t.id::text = a.task_id::text AND t.org_id::text = a.org_id::text
               LEFT JOIN ewoh_scheduling_execution e
                 ON e.assignment_id = a.assignment_id AND e.org_id = a.org_id
              WHERE a.org_id = $1 AND a.plan_id = $2`
          : `SELECT assignment_id AS id, status FROM ewoh_scheduling_plan_assignment
              WHERE org_id = $1 AND plan_id = $2`,
        [fixture.orgA.id, planId],
      )) as Array<Record<string, unknown>>;
    }

    /** 「半应用形态」计数：assignment 已推进而 task 停在推进前的状态。E-01 用它钉不变量，
     *  E-02 用它在**真正有回执在飞的窗口里**读一次，并在反证支里证明它看得见一条故意造的违规。 */
    async function countMixed(planId: string): Promise<number> {
      const rows = await owner`SELECT count(*)::int AS n FROM (
          SELECT a.assignment_id
          FROM ewoh_scheduling_plan_assignment a
          JOIN ewoh_production_task t ON t.id::text = a.task_id::text AND t.org_id::text = a.org_id::text
          WHERE a.org_id::text = ${fixture.orgA.id} AND a.plan_id = ${planId}
            AND ((a.status = 'dispatched' AND t.status NOT IN ('dispatched','received','executing'))
              OR (a.status = 'executing' AND t.status NOT IN ('executing','paused'))
              OR (a.status = 'completed' AND t.status NOT IN ('completed','exception')))
        ) mixed`;
      return Number(rows[0]?.n ?? -1);
    }

    /** 单张 assignment 的三处权威事实（assignment↔task↔execution），窗口内外各读一次做逐字对比。 */
    async function readTriple(assignmentId: string): Promise<Record<string, unknown>> {
      const rows = (await owner.unsafe(
        `SELECT a.status AS a_status, t.status AS t_status, e.status AS e_status, e.actual_end_at AS end_at
           FROM ewoh_scheduling_plan_assignment a
           LEFT JOIN ewoh_production_task t
             ON t.id::text = a.task_id::text AND t.org_id::text = a.org_id::text
           LEFT JOIN ewoh_scheduling_execution e
             ON e.assignment_id = a.assignment_id AND e.org_id = a.org_id
          WHERE a.org_id = $1 AND a.assignment_id = $2`,
        [fixture.orgA.id, assignmentId],
      )) as Array<Record<string, unknown>>;
      // 前提断言：三处事实读不齐（0 行或执行跟踪建档重复）就没有"一起收敛"可判。
      expect(rows.length).toBe(1);
      return rows[0];
    }

    /** 「派工腿」共用前提：新建一个已批准方案、顺序派工，返回那张 assignment 与派工前状态。 */
    async function dispatchedAssignment() {
      const resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      const plan = await createApprovedPlan(resources.taskId);
      const ids = (await owner.unsafe(
        `SELECT assignment_id AS id FROM ewoh_scheduling_plan_assignment
          WHERE org_id = $1 AND plan_id = $2 ORDER BY assignment_id`,
        [fixture.orgA.id, plan.planId],
      ) as Array<Record<string, unknown>>).map((r) => String(r.id));
      expect(ids.length).toBeGreaterThan(0);
      // 派工**之前**的状态从这里取，而不是写死 'approved'：B 支要退回的那个态必须是真实出现过的值。
      const preStatus = String((await readTriple(ids[0])).a_status);
      const dispatched = await dispatch(plan);
      expect(dispatched.status).toBeLessThan(400);
      const assignmentId = ids[0];
      const after = await readTriple(assignmentId);
      // 前提断言：派工没把这张 assignment 推进到守卫允许集里，回执这一路根本走不通。
      expect(RECEIPT_GUARD_ALLOWED).toContain(String(after.a_status));
      return { plan, assignmentId, preStatus, afterDispatch: after };
    }


    async function createApprovedPlan(taskId: string): Promise<SchedulingPlanV2> {
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'MANUAL',
            entityId: taskId,
          }),
        },
      );
      expect(run.status).toBe(201);
      const plan = run.body.plans[0];
      expect(plan.assignments.length).toBeGreaterThan(0);
      const approved = await apiRequest(
        handle.baseUrl,
        `/api/scheduler/plans/${plan.planId}/approve`,
        {
          method: 'POST',
          headers: jsonHeaders(approverToken),
          body: JSON.stringify({
            version: plan.version,
            snapshotVersion: plan.snapshotVersion,
          }),
        },
      );
      expect(approved.status).toBe(200);
      return plan;
    }

    function dispatch(plan: SchedulingPlanV2) {
      return apiRequest(
        handle.baseUrl,
        `/api/scheduler/plans/${plan.planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken) },
      );
    }

    /** 从响应体里取出业务裁决码（`RECEIPT_*` / `DISPATCH_*` 这类大写串），取不到就退回 HTTP 状态。 */
    function extractCode(body: unknown): string {
      if (typeof body === 'string') return body.slice(0, 60);
      if (!body || typeof body !== 'object') return '';
      for (const value of Object.values(body as Record<string, unknown>)) {
        if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{5,}$/.test(value)) return value;
        if (Array.isArray(value) && typeof value[0] === 'string') return String(value[0]).slice(0, 60);
      }
      return '';
    }

    function receipt(assignmentId: string, status: 'STARTED' | 'COMPLETED') {
          const now = new Date().toISOString();
          return apiRequest(
            handle.baseUrl,
            `/api/scheduler/executions/${assignmentId}/update`,
            {
              method: 'POST',
              headers: jsonHeaders(dispatcherToken),
              body: JSON.stringify({
                status,
                actualStartAt: now,
                ...(status === 'COMPLETED' ? { actualEndAt: now } : {}),
              }),
            },
          );
        }

    it(`E-01 派工事务与回执事务重叠 ${ROUNDS} 轮：无死锁、无 5xx，且终态不变量成立`, async () => {
      let peakConcurrency = 0;
      const verdicts: Array<{
        round: number;
        status: number;
        code: string;
        error: string;
        message: string;
      }> = [];
      const bodies: string[] = [];
      // DRC-03 用的逐路裁决记录：每一路调用是谁、要写什么、拿没拿到 2xx——
      // 「竞态只允许改变谁先提交」这句话要有牙，必须能把 2xx 逐条对回权威列。
      const roundCalls: Array<{
        round: number;
        kind: 'dispatch' | 'STARTED' | 'COMPLETED';
        assignmentId: string;
        ok: boolean;
      }> = [];
      // DRC-03 的聚合观察量：正向那两支到底被观察到几次（不非空就等于整段空转）。
      let advancedRounds = 0;
      let completedObserved = 0;

      for (let round = 1; round <= ROUNDS; round += 1) {
        const resources = await seedSchedulerFixture(owner, fixture.orgA.id);
        const plan = await createApprovedPlan(resources.taskId);
        const assignmentIds = plan.assignments.map((a) => String(a.assignmentId));

        const sampler = setInterval(() => {
          void activeBackendCount().then((n) => {
            if (n > peakConcurrency) peakConcurrency = n;
          });
        }, 2);

        // DRC-03 的前提读数：竞态**之前**每张 assignment 的权威状态（收尾要用它判"没人放行过谁"）。
        const beforeStates = await readStates(plan.planId, false);
        const beforeByAssignment = new Map(
          beforeStates.map((r) => [String(r.id), String(r.status)]),
        );
        expect(beforeStates.length).toBe(assignmentIds.length);

        try {
          // 一次发起：派工 + 每个 assignment 的 STARTED/COMPLETED 回执，全部同时下发，
          // 让回执落在派工事务「已持锁、尚未提交」的窗口里。
          // 每个调用带上自己的身份（DRC-03 要把「谁拿到 2xx」逐条对回权威列），
          // Promise.all 保序 ⇒ 下标与 calls 一一对应。
          const calls: Array<{
            kind: 'dispatch' | 'STARTED' | 'COMPLETED';
            assignmentId: string;
            run: () => Promise<unknown>;
          }> = [{ kind: 'dispatch', assignmentId: '', run: () => dispatch(plan) }];
          for (const times of [0, 1, 2, 3]) {
            void times;
            for (const id of assignmentIds) calls.push({ kind: 'STARTED', assignmentId: id, run: () => receipt(id, 'STARTED') });
          }
          for (const times of [0, 1, 2, 3]) {
            void times;
            for (const id of assignmentIds) calls.push({ kind: 'COMPLETED', assignmentId: id, run: () => receipt(id, 'COMPLETED') });
          }
          const batch = await Promise.all(calls.map((c) => c.run()));
          for (let i = 0; i < batch.length; i += 1) {
            const response = batch[i] as Awaited<ReturnType<typeof receipt>>;
            const meta = calls[i];
            const raw = response.body as {
              code?: string;
              message?: string;
              error?: string | { code?: string; message?: string };
            } | undefined;
            const code = extractCode(raw) || String(raw?.code ?? raw?.message ?? response.status);
            // Nest 的默认错误体是 `{ error: { code, message } }`，也有扁平 `{ code, message }`
            // 的接口——两种都要进扫描面，否则标记检查会漏掉真正的错误消息。
            const nested = typeof raw?.error === 'object' ? raw.error : undefined;
            verdicts.push({
              round,
              status: response.status,
              code,
              // 标记扫描只用这些**结构化错误字段**（见下方 TEST-02 的教训）。
              error: String(nested?.code ?? (typeof raw?.error === 'string' ? raw.error : '')),
              message: String(raw?.message ?? nested?.message ?? ''),
            });
            bodies.push(JSON.stringify(response.body ?? {}));
            roundCalls.push({
              round,
              kind: meta.kind,
              assignmentId: meta.assignmentId,
              ok: response.status < 400,
            });
          }
        } finally {
          clearInterval(sampler);
        }

        // 每轮收尾不变量（竞态只允许改变「谁先提交」，不允许改变一致性）
        const executions = await owner`SELECT assignment_id, count(*)::int AS n
          FROM ewoh_scheduling_execution
          WHERE org_id = ${fixture.orgA.id} AND plan_id = ${plan.planId}
          GROUP BY assignment_id`;
        for (const row of executions) expect(Number(row.n)).toBe(1);

        // 半应用形态：assignment 已推进而 task 停在推进前的状态。0 才允许。
        expect(await countMixed(plan.planId)).toBe(0);

        // DRC-03（V317·恢复轴）：上面 mixed=0 与 executions n=1 都是**缺席计数**，
        // 看不见「推进了但没收敛」。这里把「竞态只允许改变谁先提交」这句话拆成三句正向判，
        // 每句都独立重读权威列（assignment↔task↔execution），并只按这一轮**观察到**的那一支开判：
        //  ①某张 assignment 的 COMPLETED 回执拿到 2xx ⇒ 它必须 completed，且 execution.actual_end_at 非空、
        //    task 也收敛到 completed（回执不许只改一头）；
        //  ②派工拿到 2xx 而这张没被 COMPLETED 放行 ⇒ 它必须离开派工前的态（dispatched 及其后）；
        //  ③这一路都没拿到 2xx ⇒ 权威列必须逐字停在竞态之前那一刻（读不到推进就是没推进）。
        // 前提：先数这一轮谁拿到 2xx（roundCalls），空集不折成"通过"——整轮的聚合非空性在循环外断。
        const afterStates = await readStates(plan.planId, true);
        expect(afterStates.length).toBe(assignmentIds.length);
        const dispatchOk = roundCalls.some((c) => c.round === round && c.kind === 'dispatch' && c.ok);
        const completedOk = new Set(roundCalls
          .filter((c) => c.round === round && c.kind === 'COMPLETED' && c.ok)
          .map((c) => c.assignmentId));
        if (dispatchOk) advancedRounds += 1;
        completedObserved += completedOk.size;
        for (const row of afterStates) {
          const id = String(row.id);
          const nowStatus = String(row.a_status);
          if (completedOk.has(id)) {
            expect(nowStatus).toBe('completed');
            expect(String(row.t_status)).toBe('completed');
            expect(row.end_at).not.toBeNull();
          } else if (dispatchOk) {
            expect(['dispatched', 'executing', 'completed']).toContain(nowStatus);
          } else {
            expect(nowStatus).toBe(beforeByAssignment.get(id));
          }
          // 回执这一路能成功的唯一前提是 assignment 已经 dispatched（服务端
          // execution-receipt-application.service.ts:91 那道守卫），所以"派工没成而回执成了"
          // 这种组合在本轮结构上不存在；真出现了就是上面 else 分支会红在"停在竞态之前"这一句上。
        }
      }

      // DRC-02（V232·PROJ-07）「派工之后必有执行跟踪行」这条不变量此前没人钉：上面那句只保证
      // 「已有执行行的派工各只有一行」，看不见"派工成功但建档漏了"。三段各不可省：
      // 先证前提非空（否则整段是空集恒真），再判不变量，最后手工造一条孤儿证明判据真能开火。
      const LATER_STATUSES = "('dispatched','executing','completed','exception')";
      const countOrphans = async () => Number(
        ((await owner.unsafe(
          `SELECT count(*)::int AS n FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id = $1
               AND a.status IN ${LATER_STATUSES}
               AND NOT EXISTS (SELECT 1 FROM ewoh_scheduling_execution e
                                WHERE e.assignment_id = a.assignment_id AND e.org_id = a.org_id)`,
          [fixture.orgA.id],
        )) as Array<Record<string, unknown>>)[0]?.n ?? -1);
      const dispatchedPopulation = Number(
        ((await owner.unsafe(
          `SELECT count(*)::int AS n FROM ewoh_scheduling_plan_assignment
            WHERE org_id = $1 AND status IN ${LATER_STATUSES}`,
          [fixture.orgA.id],
        )) as Array<Record<string, unknown>>)[0]?.n ?? 0);
      expect(dispatchedPopulation).toBeGreaterThan(0);
      expect(await countOrphans()).toBe(0);

      const orphanAssignmentId = `drc02-orphan-${Date.now().toString(36)}`;
      await owner.unsafe(
        `INSERT INTO ewoh_scheduling_plan_assignment
           (id, assignment_id, plan_id, task_id, org_id, status, version, _created_at, _updated_at)
         SELECT gen_random_uuid(), $1, a.plan_id, a.task_id, a.org_id, a.status, a.version, now(), now()
           FROM ewoh_scheduling_plan_assignment a
          WHERE a.org_id = $2 AND a.status IN ${LATER_STATUSES}
          LIMIT 1`,
        [orphanAssignmentId, fixture.orgA.id],
      );
      expect(await countOrphans()).toBe(1);
      await owner`DELETE FROM ewoh_scheduling_plan_assignment WHERE assignment_id = ${orphanAssignmentId}`;
      expect(await countOrphans()).toBe(0);

      // DRC-03 的非空性：正向那两支至少被观察到过一次，否则上面整段是空转（八轮里一次都没有
      // 派工成功的重叠，本身就不是"测了竞态"）。①COMPLETED 那支是否被观察到只作读数打印——
      // 它取决于哪一路先提交，把它断成"必须发生"就是拿运气当前提。
      expect(advancedRounds).toBeGreaterThanOrEqual(1);

      // 证据行：重叠强度、竞态裁决分布，外加 DRC-03 的两个观察量
      const histogram = verdicts.reduce<Record<string, number>>((acc, v) => {
        const key = `${v.status} ${v.code}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const firstRejection = verdicts.findIndex((v) => v.status >= 400);
      const completedOkTotal = roundCalls.filter((c) => c.kind === 'COMPLETED' && c.ok).length;
      console.log(
        `[E-01] rounds=${ROUNDS} peakConcurrency=${peakConcurrency} `
        + `responses=${verdicts.length} histogram=${JSON.stringify(histogram)} `
        + `drc03AdvancedRounds=${advancedRounds} drc03CompletedOk=${completedOkTotal} `
        + `drc03CompletedRows=${completedObserved} `
        + `sampleRejectionBody=${firstRejection >= 0 ? bodies[firstRejection].slice(0, 160) : 'none'}`,
      );

      // 1) 功效：没有重叠，本例就没有意义——直接失败而不是假通过。
      expect(peakConcurrency).toBeGreaterThanOrEqual(2);

      // 2) 安全性：任何一路都不许以 5xx 收场（死锁/事务被中止会以 5xx 暴露）。
      const fiveXx = verdicts.filter((v) => v.status >= 500);
      expect(fiveXx.slice(0, 3)).toHaveLength(0);
      // TEST-02（V66 实测教训）：标记扫描**不能**扫整段响应正文。
      // 原来写的是 `bodies.join('|')` 全文子串匹配，于是一个随机 requestId
      // （`215b8564c39d8d4d25006b2283dac788`）里恰好出现 "25006"（死锁的 SQLSTATE）
      // 就把用例判红——一次真实的"门禁因写法而假红"。错误码/错误消息才是这些标记
      // 唯一可能出现的载体；5xx 的安全性由上一条断言独立负责。
      const errorSignals = verdicts
        .map((v) => `${v.code} ${v.error} ${v.message}`.toLowerCase())
        .join('|');
      for (const marker of DEADLOCK_MARKERS) {
        expect(errorSignals).not.toContain(marker);
      }

      // 3) 竞态确实产生了多种裁决（若全部同一裁决，说明请求被串行化了）。
      expect(Object.keys(histogram).length).toBeGreaterThanOrEqual(2);
    }, 300_000);

    /**
     * DRC-04（V317 登记·V318 补构造）：E-01 里 `mixed=0` 在**回执方向**是够不着的缺席计数——
     * 八轮重叠的裁决分布 `{"200 HEURISTIC":8,"409 409":64}`，64 路回执全部 409 在
     * `execution-receipt-application.service.ts:91` 那道派工前状态守卫上（派工是长杆，
     * 回执落在它提交之前），于是「回执把 assignment 推进了而 task/execution 没跟上」
     * 这一形态从未被逼近过。本例把**单张**回执放进一个外部可读的静止窗口，机制与 D-01 同族：
     * **行锁本身就是接缝**，不需要产品代码配合。
     *
     * 可行性来自取锁次序：plan FOR SHARE → task FOR UPDATE → assignment FOR UPDATE
     * （同文件 :67 注释「Take row locks before reading mutable state」），且三处写全在
     * :52 那一个 `runInTransaction` 里 ⇒ 外部会话只要持有那张 assignment 的行锁，
     * 回执整段被挡在任何写之前，窗口对第三方会话是静止的。
     *
     * 三支判据各自可观测，谁都不许悄悄放过：
     *  A 放行：持锁者 ROLLBACK ⇒ 回执重读原行、过守卫、一次提交三处事实。
     *    窗口内 `mixed=0` 且三处逐字等于竞态前（`midA`≡`beforeA`）、放行后三处一起收敛
     *    （assignment/task=completed 且 `actual_end_at` 非空）、且 `midA`≠`afterA`
     *    ——后一句防止"回执其实什么都没推进"把整段读成空窗口。
     *  B 重判：持锁者把 assignment 写回派工前的那个态并 COMMIT ⇒ 锁释放后 `SELECT FOR UPDATE`
     *    在**新版本**上返回 ⇒ 守卫必须据新版本拒绝（409 `RECEIPT_ASSIGNMENT_NOT_DISPATCHED`），
     *    且三处权威事实不得留下回执这一路的任何痕迹。若回执拿到 2xx，就是"用锁前的无锁快照
     *    判断、再写锁后的行"——真缺陷，本支按实读红。
     *  C 反证：故意提交一条半应用形态（assignment=completed 而 task 原地不动）⇒ `mixed` 必须报 1，
     *    恢复后必须回 0。没有这一支，A/B 里那两次 `mixed=0` 与恒真判据在结构上不可区分。
     */
    it('E-02 单张回执被行锁整段挡在写之前：窗口内只有竞态前、放行后三处一起收敛、重判支据新版本拒绝（DRC-04）', async () => {
      const A = await dispatchedAssignment();
      // B 支的前提：派工前那一态必须落在守卫允许集**之外**，否则"据新版本拒绝"无从判起。
      expect(RECEIPT_GUARD_ALLOWED).not.toContain(A.preStatus);
      const beforeA = A.afterDispatch;
      expect(await countMixed(A.plan.planId)).toBe(0);

      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      let windowA = { waited: false, probes: 0, waiters: 0 };
      let windowB = { waited: false, probes: 0, waiters: 0 };
      try {
        // ── A 放行支 ──────────────────────────────────────────────────
        // 单连接显式事务：begin/commit 之间锁一直持有，回执那道 FOR UPDATE 必然排队。
        // 用 owner 持锁，才能在同会话里查询到别的会话的锁状态（跨角色会话的 pg_stat_activity
        // 会被权限隐藏，实测只显 `<insufficient privilege>`，见 control-delivery-race 的注释）。
        await holder.unsafe('BEGIN');
        const lockedA = await holder.unsafe(
          `SELECT id FROM ewoh_scheduling_plan_assignment WHERE assignment_id = '${A.assignmentId}' FOR UPDATE`,
        );
        // 前提断言：锁 0 行的 FOR UPDATE 不报错，会把"没人排队"伪装成构造成功。
        expect((lockedA as unknown[]).length).toBe(1);

        const receiptAPromise = receipt(A.assignmentId, 'COMPLETED');
        windowA = await waitTupleLockQueued(holder, 'ewoh_scheduling_plan_assignment');
        // 功效断言：没构造出重叠，本支就没有意义——直接失败而不是"跳过即通过"。
        expect(windowA.waited).toBe(true);

        const midA = await readTriple(A.assignmentId);
        expect(midA).toEqual(beforeA);
        expect(await countMixed(A.plan.planId)).toBe(0);

        await holder.unsafe('ROLLBACK');
        const receiptA = await receiptAPromise;
        expect(receiptA.status).toBeLessThan(400);
        const afterA = await readTriple(A.assignmentId);
        expect(String(afterA.a_status)).toBe('completed');
        expect(String(afterA.t_status)).toBe('completed');
        expect(afterA.end_at).not.toBeNull();
        expect(await countMixed(A.plan.planId)).toBe(0);
        // 窗口"是活的"：静止期读到的那一版必须与最终落地的那一版不同，否则上面等价于什么都没读。
        expect(midA).not.toEqual(afterA);
        console.log(
          `[E-02A] tuple 锁排队 waited=${windowA.waited} probes=${windowA.probes}(×25ms) waiters=${windowA.waiters} `
          + `窗口内三处=${JSON.stringify(midA)} 放行后三处=${JSON.stringify(afterA)} `
          + `receiptA=${receiptA.status} mixed 窗口内/放行后=0/0 ⇒ 机制=「外部持 assignment 行锁 → 回执整段排队 → `
          + `提交前对第三方一律不可见 → 放行后 assignment↔task↔execution 一次收敛」`,
        );

        // ── B 重判支 ──────────────────────────────────────────────────
        const B = await dispatchedAssignment();
        const beforeB = B.afterDispatch;
        await holder.unsafe('BEGIN');
        const lockedB = await holder.unsafe(
          `SELECT id FROM ewoh_scheduling_plan_assignment WHERE assignment_id = '${B.assignmentId}' FOR UPDATE`,
        );
        expect((lockedB as unknown[]).length).toBe(1);

        const receiptBPromise = receipt(B.assignmentId, 'COMPLETED');
        windowB = await waitTupleLockQueued(holder, 'ewoh_scheduling_plan_assignment');
        expect(windowB.waited).toBe(true);
        // 在持锁事务里改同一行再提交：回执醒来后拿到的是新版本（READ COMMITTED 重取锁后重读）。
        await holder.unsafe(
          `UPDATE ewoh_scheduling_plan_assignment SET status = '${B.preStatus}' WHERE assignment_id = '${B.assignmentId}'`,
        );
        await holder.unsafe('COMMIT');
        const receiptB = await receiptBPromise;
        console.log(
          `[E-02B] tuple 锁排队 waited=${windowB.waited} probes=${windowB.probes}(×25ms) `
          + `持锁者把态改回「${B.preStatus}」并提交 → 回执裁决=${receiptB.status} `
          + `code=${extractCode((receiptB.body as { error?: unknown } | undefined)?.error ?? receiptB.body)} `
          + `body=${JSON.stringify(receiptB.body ?? {}).slice(0, 160)}`,
        );
        expect(receiptB.status).toBe(409);
        expect(JSON.stringify(receiptB.body)).toContain('RECEIPT_ASSIGNMENT_NOT_DISPATCHED');
        const afterB = await readTriple(B.assignmentId);
        // 被拒绝的那一路回执一条事实都不许留下：除持锁者自己写的那个态，三处逐字停在派工后。
        expect(afterB).toEqual({ ...beforeB, a_status: B.preStatus });
        expect(await countMixed(B.plan.planId)).toBe(0);
      } finally {
        await holder.end({ timeout: 5 });
      }

      // ── C 反证支：A/B 里那两次 `mixed=0` 不是恒真 ────────────────────
      const C = await dispatchedAssignment();
      expect(await countMixed(C.plan.planId)).toBe(0);
      await owner.unsafe(
        `UPDATE ewoh_scheduling_plan_assignment SET status = 'completed' WHERE assignment_id = $1`,
        [C.assignmentId],
      );
      const taskStatusOfC = String((await readTriple(C.assignmentId)).t_status);
      const violated = await countMixed(C.plan.planId);
      console.log(
        `[E-02C] 故意半应用 assignment=completed/task=${taskStatusOfC} ⇒ mixed=${violated}`
        + `（必须 >0，否则回执方向的不变量判据是恒真的）`,
      );
      expect(violated).toBeGreaterThan(0);
      await owner.unsafe(
        `UPDATE ewoh_scheduling_plan_assignment SET status = 'dispatched' WHERE assignment_id = $1`,
        [C.assignmentId],
      );
      expect(await countMixed(C.plan.planId)).toBe(0);

      // DRC-04 的闭合读数（一支一行，供登记引用）：两支窗口各在第几拍被观测到。
      // 不必再断一次 waited——A/B 支各自的效力断言已经先一步把"没构造出窗口"判成红。
      console.log(
        `[E-02] DRC-04 窗口构造 probes A=${windowA.probes} B=${windowB.probes}`
        + `（×25ms，各 1 个等待者）⇒ 回执方向的半应用不变量已从「无可满足反例」转为「窗口内读得到、`
        + `放行后收敛得到、反例看得见」`,
      );
    }, 300_000);

    /**
     * 共享取手（V329 提到这一层）：**先查库里已有的已批准方案**，不够再播种＋整单排产＋审批。
     *
     * 两条实测前提决定了这个形状：
     *  ⑴ 同一个库里**第二次整单排产返回 0 个方案**（V327 记下、成因未追查，已登记为夹具事实而非产品缺陷）
     *     ⇒ "再排一次就有一个新方案"不能当前提，否则后跑的那支会红在前提上而不是红在判据上；
     *  ⑵ 方案表 `ewoh_schedule_plan` 没有租户列（`server/database/schema.ts:657` 起的表定义），
     *     契约里 `tenant_column` 是针对 `child_table` 声明的 ⇒ 租户过滤位只能挂子表；
     *     第一版把它挂到父表上，读回来 0 行，被误读成"库里没有已批准方案"（0 行与"没有"同形）。
     *
     * 表名／列名／待派工取值全部由契约 `wave_completion` 组装（与 WAVE-01 同一真值源）；
     * `device_id`、`version` 是夹具装配用的列、不承载判据，所以留在原地。
     * 落选项的形状一律进错误消息——"夹具没造出来"与"没有可用窗口"必须可分。
     */
    async function acquireApprovedPlan(minRows: number): Promise<{
      planId: string;
      rows: Array<{ id: string; device: string; version: number }>;
    }> {
      const rejects: string[] = [];
      const shapes: string[] = [];
      const select = async () => (await owner.unsafe(
        `SELECT p.${ident('parent_key')} AS plan_id, a.${ident('child_key')} AS id,`
        + ` a.device_id AS device, a.version AS version`
        + ` FROM ${ident('child_table')} a JOIN ${ident('parent_table')} p`
        + `   ON a.${ident('child_parent_key')} = p.${ident('parent_key')}`
        + ` WHERE a.${ident('tenant_column')} = $1`
        + `   AND a.${ident('child_status_column')} = $2 AND p.${ident('parent_status_column')} = $2`
        + ` ORDER BY p.${ident('parent_key')}, a.${ident('child_key')}`,
        [fixture.orgA.id, WC.pending_status],
      )) as Array<Record<string, unknown>>;
      const pick = (rows: Array<Record<string, unknown>>) => {
        const byPlan = new Map<string, Array<{ id: string; device: string; version: number }>>();
        for (const r of rows) {
          const dev = String(r.device ?? 'NULL');
          if (dev === 'NULL') continue;
          const k = String(r.plan_id);
          const list = byPlan.get(k) ?? [];
          list.push({ id: String(r.id), device: dev, version: Number(r.version) });
          byPlan.set(k, list);
        }
        for (const [planId, list] of byPlan) {
          const devices = new Set(list.map((l) => l.device));
          shapes.push(
            `${planId.slice(-12)}:${list.length}条/${devices.size}台`
            + `=${JSON.stringify(list.map((l) => l.device.slice(0, 8)))}`,
          );
          // 要求"每条各占一台"：同设备复用会让去重漏掉一条已批准 assignment，
          // 后面那几根余量计数就对不上——那是夹具形状问题，在这里拒掉而不是让它变成假红。
          if (list.length >= minRows && devices.size >= minRows) return { planId, rows: list };
        }
        return null;
      };
      let got = pick(await select());
      for (let attempt = 0; !got && attempt < 4; attempt += 1) {
        // 每条播种给 1 个任务＋2 台设备；N 次播种＋一次整单排产给出 N 条/N 台（V327 实测定形状）。
        for (let i = 0; i < Math.max(3, minRows); i += 1) await seedSchedulerFixture(owner, fixture.orgA.id);
        const run = await apiRequest<{ plans?: SchedulingPlanV2[] }>(
          handle.baseUrl, '/api/scheduler/runs',
          {
            method: 'POST',
            headers: jsonHeaders(dispatcherToken),
            body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL' }),
          },
        );
        if (run.status !== 201) {
          rejects.push(`第${attempt + 1}次排产 run=${run.status}`);
        }
        const planList = run.body.plans ?? [];
        if (planList.length === 0) rejects.push(`第${attempt + 1}次整单排产返回 0 个方案`);
        for (const p of planList) {
          const approved = await apiRequest(
            handle.baseUrl, `/api/scheduler/plans/${p.planId}/approve`,
            {
              method: 'POST',
              headers: jsonHeaders(approverToken),
              body: JSON.stringify({ version: p.version, snapshotVersion: p.snapshotVersion }),
            },
          );
          // 审批不过的候选换下一个：这里不能 expect 死，否则"候选里有一个可用"读成"必须全可用"。
          if (approved.status !== 200) rejects.push(`${p.planId.slice(-12)}:approve=${approved.status}`);
        }
        got = pick(await select());
      }
      if (!got) {
        throw new Error(
          `夹具前提不成立：拿不到"≥${minRows} 条已批准且各占一台设备"的方案`
          + `（落选=${rejects.slice(0, 8).join(' | ') || '无'}；`
          + `看到的已批准方案形状=${shapes.slice(0, 12).join(' | ') || '库里一个 approved 方案都没有'}）`
          + '⇒ 窗口无从构造，不许把"夹具没造出来"读成"没有窗口"',
        );
      }
      return got;
    }

    /**
     * WAVE-02（V329）：**同一条 assignment 被两个派发意图撞上**时，落空那一支的"整波回滚"到底回滚了
     * 什么、以及那个 409 是不是合法调用方该重试的一档。WAVE-01 管的是父行终态取在锁外（V327 缺陷），
     * 这一支管子表 CAS 落空的**后果面**——读码已知它抛 `ASSIGNMENT_CONCURRENT_UPDATE`
     * （`dispatch-coordinator.service.ts:688-691`，抛点在 `runInTransaction` 回调内），
     * 但"抛了以后同波里那条没被撞的 assignment 还在不在待派工、预占有没有留下半个、重试能不能收敛"
     * 此前**没有任何常驻臂**证过（V328 §5.3n36 ⑤ 把它留成未证）。
     *
     * 窗口怎么撑开（确定性，不靠采样撞概率）：外部同权限会话先对 x 那条 assignment 做**不提交**的
     * 行锁 UPDATE ⇒ 波次请求 `[x, y]` 在自己的子表 CAS 上排队（`waitTupleLockQueued` 用 5 ms 档
     * 观测 tuple 锁，理由见 `e2e-lock-window` 头部）；排队成立后再由同一会话把"另一个派发者先把 x 落地"
     * 写成事实（`status → 契约终态值`、`version + 1`）并提交 ⇒ READ COMMITTED 下 R 醒来重判谓词，
     * `version` 与 `status` 双双不匹配 ⇒ CAS 落空。**没有用 HTTP 并发去撞**：两个真实请求的先后
     * 取决于锁队列的授予顺序，那会把"谁赢"写进判据，而本例要断的是**落空之后的账**。
     *
     * 三根判据（缺一根就退化成"报错了"）：
     *  ① 败者必须报 409 且错误里点名那条 assignment（不是 500、不是静默 200）；
     *  ② 整波回滚要看得见：同波那条 `y` 必须**仍在待派工**、本方案的预占行必须**归零**、
     *     x 的事件行必须**一条没有**（预占在 :626、事件在 :697，都在 CAS 之前/之后的同一事务里，
     *     所以"只有父行没动"是不够的——要逐张表点名）；
     *  ③ 重试语义：拿**新的**待派工集合重发 `[y]` 必须 200 并把方案推到契约终态
     *     （⇒ 那个 409 确实是"改请求体重投"那一档，而不是"这条波永远废了"）。
     */
    it('WAVE-02 同一条 assignment 被两个派发意图撞上：败者 409 带 retryable=false、同波那条回滚到待派工、按新集合重投那一条必须落地', async () => {
      /**
       * 夹具：取一个"≥2 条已批准、且这两条各占一台不同设备"的方案。
       * 与 WAVE-01 不同，这里**不要求三条**（串行段在本例不承担归因职责），但要求两台设备——
       * 否则 x、y 同设备时预占会互相顶，红因说不清。
       * 先查库里已有的已批准方案，再补播种＋整单排产：V327 实测第二次整单排产会返回 0 个方案，
       * 把"能不能拿到夹具"绑在"每次排产都得出方案"上会把夹具问题读成产品问题。
       */
      // 取 5 条：本支用 2 条（x 由外部会话落地、y 走重试），剩下 3 条留给后面那支 WAVE-01
      //（一个方案只有一个终态，所以两支必须共用一个方案、且这一支先跑）。
      const five = await acquireApprovedPlan(5);
      const devices = new Set(five.rows.map((r) => r.device));
      if (devices.size < 5) {
        throw new Error(`夹具形状不足：5 条里的设备只有 ${devices.size} 台，x/y 会同设备`);
      }
      const F = { planId: five.planId, x: five.rows[0], y: five.rows[1] };
      if (F.x.device === F.y.device) {
        throw new Error(`夹具形状不足：前两条同设备 ${F.x.device.slice(0, 8)}`);
      }

      const pendingOf = async (planId: string) => (await owner.unsafe(
        expandContractSql(WC.pending_count_sql), [planId, fixture.orgA.id],
      )) as Array<Record<string, unknown>>;
      const statusOf = async (planId: string) => (await owner.unsafe(
        expandContractSql(WC.parent_status_sql), [planId],
      )) as Array<Record<string, unknown>>;
      const rowCount = async (sql: string, param: string) =>
        Number(((await owner.unsafe(sql, [param])) as Array<Record<string, unknown>>)[0]?.n ?? -1);
      const eventsFor = (id: string) => rowCount(
        'SELECT count(*)::int AS n FROM ewoh_assignment_event WHERE assignment_id = $1', id,
      );
      const reservedFor = (planId: string) => rowCount(
        `SELECT count(*)::int AS n FROM ewoh_resource_reservation r`
        + ` JOIN ewoh_scheduling_plan_assignment a ON a.assignment_id = r.assignment_id`
        + ` WHERE a.plan_id = $1`, planId,
      );

      const before = {
        pending: Number((await pendingOf(F.planId))[0].n),
        status: String((await statusOf(F.planId))[0]?.s ?? 'MISSING'),
        eventsX: await eventsFor(F.x.id),
        reserved: await reservedFor(F.planId),
      };
      expect(before.status).toBe(WC.from_status);
      expect(before.eventsX).toBe(0);

      const racer = postgres(config!.ownerDatabaseUrl, { max: 1 });
      let window = { waited: false, probes: 0, waiters: 0 };
      let loser: { status: number; body: Record<string, unknown> } | undefined;
      try {
        // ① 把 x 的行锁住但不改它 ⇒ 波次请求会读完待派工集合、停在它自己的子表 CAS 上。
        //    必须带 RETURNING：UPDATE 没有 RETURNING 时驱动返回空数组，`length === 1` 会把
        //    "确实锁住了那一行"和"一句合法的 0 行更新"读成同一件事（本轮实测踩过：红在 0）。
        await racer.unsafe('BEGIN');
        const held = await racer.unsafe(
          `UPDATE ${ident('child_table')} SET ${ident('child_status_column')}`
          + ` = ${ident('child_status_column')} WHERE ${ident('child_key')} = $1`
          + ` AND ${ident('tenant_column')} = $2 RETURNING ${ident('child_key')}`,
          [F.x.id, fixture.orgA.id],
        );
        expect((held as unknown[]).length).toBe(1);

        const wave = apiRequest<{ dispatch?: Record<string, unknown>; message?: string; error?: unknown }>(
          handle.baseUrl, `/api/scheduler/plans/${F.planId}/dispatch`,
          {
            method: 'POST',
            headers: jsonHeaders(dispatcherToken),
            body: JSON.stringify({ assignmentIds: [F.x.id, F.y.id] }),
          },
        );
        window = await waitTupleLockQueued(owner, ident('child_table'), FAST_WINDOW);
        expect(window.waited).toBe(true);

        // ② 在 R 排队期间，把"另一个派发者已经把 x 落地"写成已提交的事实。
        await racer.unsafe(
          `UPDATE ${ident('child_table')} SET ${ident('child_status_column')} = $3, version = version + 1`
          + ` WHERE ${ident('child_key')} = $1 AND ${ident('tenant_column')} = $2`
          + ` RETURNING ${ident('child_key')}, version`,
          [F.x.id, fixture.orgA.id, WC.to_status],
        );
        await racer.unsafe('COMMIT');
        const res = await wave;
        loser = { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
        const afterFail = {
          pending: Number((await pendingOf(F.planId))[0].n),
          status: String((await statusOf(F.planId))[0]?.s ?? 'MISSING'),
          eventsX: await eventsFor(F.x.id),
          reserved: await reservedFor(F.planId),
        };
        console.log(
          `${lockWindowNote('WAVE-02A', window, `方案=${F.planId} x=${F.x.id.slice(0, 8)}`, FAST_WINDOW.intervalMs)} `
          + `败者=${loser.status} 响应体=${JSON.stringify(loser.body).slice(0, 400)} `
          + `(待派工,方案, x事件, 预占)=(${[afterFail.pending, afterFail.status, afterFail.eventsX, afterFail.reserved].join(',')}) `
          + `改前=(${[before.pending, before.status, before.eventsX, before.reserved].join(',')})`,
        );
        // ① 落空必须响，而且响在该动的那条上。响应是**信封形状**（本轮实测）：
        //   `{ error: { code, message, errorCode, requestId, retryable, recommendedAction } }`
        //   ——第一版直读 `body.message` 拿到空串，于是"错误里点名那条 assignment"这根判据
        //   会在实现根本没报错时也读成"读不到"（空串与缺失同形）。
        const envelope = (body: Record<string, unknown> | undefined) => {
          const inner = body?.error;
          return inner && typeof inner === 'object'
            ? (inner as Record<string, unknown>)
            : (body ?? {});
        };
        const err = envelope(loser.body);
        const errText = String(err.message ?? '');
        expect(loser.status).toBe(409);
        expect(errText).toContain('ASSIGNMENT_CONCURRENT_UPDATE');
        expect(errText).toContain(F.x.id);
        // ①′ 语义那一半（V328 留在账上的"那个 409 是不是该重试那一档"）：响应自己带机器可读的
        //   `retryable`／`recommendedAction`。实测读数 `retryable=false` ＋"刷新后操作"⇒
        //   "不许原样重投（同一条已被别人派完，原样重投会换一支错误）"与"按新集合重投可收敛"
        //   两件事是分开的——后者由下面那根重试断言钉。
        expect(err.retryable).toBe(false);
        expect(String(err.recommendedAction ?? '')).not.toBe('');
        // ② 整波回滚逐张表点名：同波那条没被撞的 y 必须回到待派工（余量 = 改前 - 1，即只少了外部落地那条 x）
        expect(afterFail.pending).toBe(before.pending - 1);
        expect(afterFail.status).toBe(WC.from_status);
        expect(afterFail.eventsX).toBe(0);
        expect(afterFail.reserved).toBe(0);

        // ③ 重试语义：拿**新的**待派工集合重发，必须 200 并把那一条真正落地。
        //   这里**不**断"方案进契约终态"——本支是从同一个已批准方案上取 5 条里的 2 条，
        //   剩下 3 条是**故意留给后面那支 WAVE-01** 的（同一库里第二次整单排产返回 0 个方案，
        //   再造一个方案不是可依赖的前提），所以末态必须还是 `from_status`、余量必须是 3。
        //   把它写成"没进终态"而不是"进终态"，是为了让下一支的起点可读：这条红的时候先查是不是
        //   上一支把行派多了，而不是怀疑本支的回滚。
        const retry = await apiRequest<{ dispatch?: Record<string, unknown> }>(
          handle.baseUrl, `/api/scheduler/plans/${F.planId}/dispatch`,
          {
            method: 'POST',
            headers: jsonHeaders(dispatcherToken),
            body: JSON.stringify({ assignmentIds: [F.y.id] }),
          },
        );
        const finalState = {
          pending: Number((await pendingOf(F.planId))[0].n),
          status: String((await statusOf(F.planId))[0]?.s ?? 'MISSING'),
          reserved: await reservedFor(F.planId),
          eventsY: await eventsFor(F.y.id),
          eventsX: await eventsFor(F.x.id),
        };
        console.log(
          `[WAVE-02R] 重试=${retry.status} 末态(方案=${finalState.status},剩 ${finalState.pending},`
          + `预占 ${finalState.reserved}, y事件=${finalState.eventsY}, x事件=${finalState.eventsX})`,
        );
        expect(retry.status).toBe(200);
        expect(finalState.pending).toBe(before.pending - 2);
        expect(finalState.status).toBe(WC.from_status);
        // 重试那一支自己走完全套副作用：y 有事件行、预占行在；而被别人抢掉的 x 一条事件都没有
        // ⇒ "落空的那支没留下半个投影"与"成功的那支该写的都写了"两根方向各自有证。
        expect(finalState.eventsY).toBe(1);
        expect(finalState.eventsX).toBe(0);
        expect(finalState.reserved).toBeGreaterThan(0);
      } finally {
        await racer.end({ timeout: 5 });
      }
    }, 300_000);

    /**
     * WAVE-01（V327）：分波派工的「波次是否派完」判据原先取在**资源锁之前**的一次无锁子表读上。
     *
     * 缺陷形状（读码提出、实测确认）：`dispatch-coordinator.service.ts` 先在 :367 无锁读
     * 本方案全部 assignment、在 :371 由它派生 `proposed`，再在 :437-442 才取设备行 `FOR UPDATE`，
     * 而父行的 CAS 谓词只看 `plan.status='approved'`（不含任何子表列）⇒ 它挡不住"另一波在这中间
     * 把剩下的派完并提交"。V327 改前的实测末态（tmp/v327-exp6.log）：A 波 200、`approved` 归零，
     * 方案却停在 `approved`，且响应 `remainingAssignmentIds` 仍指着 B 波那条**已派完**的 assignment。
     * 修法与链上那五处同口径：锁 → 读 → 写（资源锁与事务内复查都过完之后重读待派工集合）。
     *
     * **判据来源（PCND-01，V328）**：本例的表名／列名／"待派工"取值／父行迁移两端／响应里该看
     * 哪一格，全部由 `contracts/state-machines/plan.yaml` 的 `wave_completion` 块组装（见文件顶部
     * `WC`）——测试里不留字面 'approved'/'dispatched'。因此改契约不改实现（或反之）本例会红，
     * 而不是像以前那样：判据写在测试里，契约怎么改都没人报警。
     *
     * 两支都是"应然判据"，与实现怎么写无关：
     *  A 重叠支：holder 持住 A 波那台的设备行 ⇒ A 读完 proposed 后堵在设备锁上（tuple 锁观测用
     *    5 ms 档，理由见 `e2e-lock-window` 头部：采样粒度是第二根轴，25 ms 档会把真窗口读成零）；
     *    B 波用的是**其余**设备 ⇒ 不被这把锁挡，先提交；放行后 A 醒来派完最后一条 ⇒
     *    `approved` 必须归零、方案必须进契约终态 `dispatched`（plan.yaml:17 那条迁移、:20 的终态表），
     *    且 A 自己那份响应必须报 remaining=0——旧代码在这里报的是"还剩 B 那条"，是本改动**唯一**
     *    可观察到的量，所以两根都钉。
     *  S 串行段（先跑，作归因对照）：把其余各条**一先一后**派掉 ⇒ 方案必须留在 `approved`、
     *    响应余量必须报真实的剩余条数。缺这一段，A 支红了分不清"并发把账算错"还是"夹具本来就
     *    派不到终态"；而它那一格 remaining=N 又反过来证明 A 支那根 `remaining===0` 不是恒真判据
     *    （只断末态的话，"永远报 0"的实现也能通过）。
     */
    it('WAVE-01 两波派工在设备锁上重叠：approved 归零后方案必须进 dispatched，响应余量取锁后真值', async () => {
      function dispatchWave(planId: string, assignmentIds: string[]) {
        // 响应体用**开放对象**接：要断的那一格键名由契约 `response_field` 给出，
        // 在测试里写成固定字面量等于把判据的键名又搬回测试。
        return apiRequest<{ dispatch?: Record<string, unknown> }>(
          handle.baseUrl,
          `/api/scheduler/plans/${planId}/dispatch`,
          {
            method: 'POST',
            headers: jsonHeaders(dispatcherToken),
            body: JSON.stringify({ assignmentIds }),
          },
        );
      }

      /** 权威对（判据由契约组装）：父行状态 + 该方案还剩几条待派工。 */
      async function waveState(planId: string) {
        const [row] = (await owner.unsafe(
          expandContractSql(WC.parent_status_sql),
          [planId],
        )) as Array<Record<string, unknown>>;
        const [left] = (await owner.unsafe(
          expandContractSql(WC.pending_count_sql),
          [planId, fixture.orgA.id],
        )) as Array<Record<string, unknown>>;
        return {
          planStatus: String(row?.s ?? 'MISSING'),
          pendingLeft: Number(left.n),
        };
      }

      const W = await acquireApprovedPlan(3);
      // 划分：第 0、1 条留给重叠段的 A/B 两波（各占一台设备），其余先**串行**派掉。
      const [wa, wb] = W.rows;
      const rest = W.rows.slice(2);

      /** 响应里的"还剩几条"：键名同样取自契约（`response_field`），测试里不出现字面键名。 */
      function remainingOf(dispatch: Record<string, unknown> | undefined): number {
        return Number((dispatch ?? {})[WC.response_field]);
      }
      /** 契约声明的另一格：余量的**明细清单**（旧实现在这里会指着一条已派完的 assignment）。 */
      function remainingIdsOf(dispatch: Record<string, unknown> | undefined): unknown[] {
        const v = (dispatch ?? {})[WC.response_ids_field];
        return Array.isArray(v) ? v : ['契约声明的响应清单格缺失或不是数组'];
      }
      /** 本波自己派了几条（键名同样来自契约）。 */
      function dispatchedOf(dispatch: Record<string, unknown> | undefined): number {
        return Number((dispatch ?? {})[WC.response_dispatched_field]);
      }

      // ── S 串行段（归因对照＋"没派完不许进终态"那一半）────────────────
      // 如果只断重叠段的末态 `dispatched`，`remainingAssignments===0` 那根判据可能被
      // "永远报 0"的实现满足；这一段要求**同一根**判据在未派完时报真实余量。
      const serial = await dispatchWave(W.planId, rest.map((x) => x.id));
      const afterSerial = await waveState(W.planId);
      console.log(
        `[WAVE-01S] 方案=${W.planId} 波次划分=${JSON.stringify(W.rows.map((x) => x.device.slice(0, 8)))}`
        + ` 串行波=${serial.status} 派 ${rest.length} 条后(方案=${afterSerial.planStatus},`
        + `剩 ${afterSerial.pendingLeft}) 响应=${JSON.stringify(serial.body?.dispatch ?? {})}`,
      );
      expect(serial.status).toBe(200);
      expect(afterSerial.pendingLeft).toBe(2);
      expect(afterSerial.planStatus).toBe(WC.from_status);
      expect(remainingOf(serial.body?.dispatch)).toBe(2);

      // ── A 重叠支 ────────────────────────────────────────────────────
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      let window = { waited: false, probes: 0, waiters: 0 };
      try {
        await holder.unsafe('BEGIN');
        const locked = await holder.unsafe(
          `SELECT id FROM ewoh_device WHERE id = $1 FOR UPDATE`,
          [wa.device],
        );
        // 前提断言：锁 0 行的 FOR UPDATE 不报错，会把"没人排队"伪装成构造成功。
        expect((locked as unknown[]).length).toBe(1);

        const waveAPromise = dispatchWave(W.planId, [wa.id]);
        window = await waitTupleLockQueued(owner, 'ewoh_device', FAST_WINDOW);
        // 功效断言：没构造出重叠，本支就没有意义——直接失败而不是"跳过即通过"。
        expect(window.waited).toBe(true);

        const waveB = await dispatchWave(W.planId, [wb.id]);
        const mid = await waveState(W.planId);
        expect(waveB.status).toBe(200);
        // A 还在锁上排队 ⇒ 中途必须恰好剩 A 那一条没派完（这同时证明 A 确实没提前落地）。
        expect(mid.pendingLeft).toBe(1);
        expect(mid.planStatus).toBe(WC.from_status);

        await holder.unsafe('COMMIT');
        const waveA = await waveAPromise;
        const final = await waveState(W.planId);
        const d = waveA.body?.dispatch ?? {};
        console.log(
          `${lockWindowNote('WAVE-01A', window, `方案=${W.planId}`, FAST_WINDOW.intervalMs)} `
          + `B 波=${waveB.status} 中途(方案=${mid.planStatus},剩 ${mid.pendingLeft}) `
          + `A 波=${waveA.status} 末态(方案=${final.planStatus},剩 ${final.pendingLeft}) `
          + `A 响应 dispatch=${JSON.stringify(d)}`,
        );
        expect(waveA.status).toBe(200);
        expect(final.pendingLeft).toBe(0);
        expect(final.planStatus).toBe(WC.to_status);
        expect(String(d.planStatus)).toBe(WC.to_status);
        expect(remainingOf(d)).toBe(0);
        expect(remainingIdsOf(d)).toEqual([]);
        expect(dispatchedOf(d)).toBe(1);
      } finally {
        await holder.end({ timeout: 5 });
      }
    }, 300_000);

  },
);
