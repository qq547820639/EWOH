/**
 * 投影一致性格（V102）：方案取消这条边上，「方案投影」与「执行跟踪」是否同进退。
 *
 * 起因：链上派生事实普查里，这一格是唯一"注释自己声称有保证"的双写——
 * `scheduler-plan-application.service.ts#cancelPlanV2` 先 `await planService.cancelPlan(...)`
 * （方案投影：plan/assignment/预占/任务回池/outbox），**再** `await executionService.cancelForAssignments(...)`
 * （执行跟踪：把未开始的 Execution 行标 CANCELLED），注释写着"执行跟踪与派工事实同进退"。
 * 两次 await 若同处一个请求事务（`org-context.interceptor.ts` 给每个 HTTP handler 包 runInTransaction），
 * 这句话才成立；但它此前只是**读代码得到的**。按 V92 对 F-05 用过的同一手法测它：
 * **只让第二处写失败**，看第一处会不会跟着回去。
 *
 * 三条断言互为对照，缺任何一条结论都不成立：
 *  PC-01 正常路径：取消后 plan/assignment/execution 三处一起落定（否则"同进退"的前提就不成立）。
 *  PC-02 故障注入：一条只挡「执行行改成 CANCELLED」的 BEFORE UPDATE 触发器 ⇒ 读三处事实。
 *       同一事务 ⇒ 三处都回到取消前（HTTP 500）；
 *       不同事务 ⇒ 方案已 cancelled 而执行行仍 PLANNED，即投影分叉（按实测写断言并登记缺陷）。
 *  PC-03 反向控制 + 收尾：摘掉触发器后对同一份方案重跑取消必须成功（证明 PC-02 的"没落定"
 *       只归因于那一条触发器，而不是取消本身走不到执行那一步）；并断言触发器不留在共享库上。
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { SchedulingPlanV2 } from '../../shared/api.interface';
import { resolveE2EConfig } from '../helpers/e2e-config';
import { lockWindowNote, waitTupleLockQueued } from '../helpers/e2e-lock-window';
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

const config = resolveE2EConfig();
const TRIGGER = 'ewoh_e2e_pc_block_execution_cancel';
const FN = 'ewoh_e2e_pc_block_fn';
const FAULT = 'e2e PC-02 执行跟踪写入被人为挡住';

type Projection = {
  planStatus: string;
  assignments: number;
  cancelledAssignments: number;
  executions: number;
  cancelledExecutions: number;
};

(config ? describe : describe.skip)(
  '方案取消的投影一致性 E2E（真实 PostgreSQL：方案投影与执行跟踪是否同进退）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let dispatcherToken = '';
    let approverToken = '';
    const runId = randomUUID().slice(0, 8);
    let faultedPlanId = '';

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      dispatcherToken = (await login(
        handle.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password,
      )).body.accessToken;
      approverToken = (await login(
        handle.baseUrl, fixture.approverA.username, fixture.approverA.password,
      )).body.accessToken;
    }, 120_000);

    afterAll(async () => {
      // 触发器/函数建在共享库的表上：漏给后面的用例会污染整条重放，离开前一律清干净。
      if (owner) {
        await owner.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_scheduling_execution;`);
        await owner.unsafe(`DROP FUNCTION IF EXISTS public.${FN}();`);
      }
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    /** 一次取消要同时落定的三处事实；全部从库里读，不信任响应体。 */
    async function projection(org: string, planId: string): Promise<Projection> {
      const rows = await owner`
        SELECT
          (SELECT p.status FROM ewoh_schedule_plan p
             WHERE p.org_id::text = ${org} AND p.plan_id = ${planId}) AS plan_status,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${planId}) AS assignments,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${planId}
               AND a.status = 'cancelled') AS cancelled_assignments,
          (SELECT count(*)::int FROM ewoh_scheduling_execution e
             WHERE e.org_id::text = ${org} AND e.plan_id = ${planId}) AS executions,
          (SELECT count(*)::int FROM ewoh_scheduling_execution e
             WHERE e.org_id::text = ${org} AND e.plan_id = ${planId}
               AND e.status = 'CANCELLED') AS cancelled_executions`;
      const r = rows[0] as Record<string, unknown>;
      return {
        planStatus: String(r.plan_status),
        assignments: Number(r.assignments),
        cancelledAssignments: Number(r.cancelled_assignments),
        executions: Number(r.executions),
        cancelledExecutions: Number(r.cancelled_executions),
      };
    }

    /**
     * 每格自带一份现场（run → approve → dispatch）。
     * 为什么要各自 seed 一份任务/人员/设备而不是共用：V102 第一版共用同一 taskId，
     * 第二格的 `/runs` 返回 201 但 plans 为空——上一格的取消已把该任务退回池中，
     * 同一任务的二次触发不在本例的问题域里，夹具必须互不知情。
     */
    async function dispatchedPlan(tag: string): Promise<string> {
      const resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: resources.taskId,
          }),
        },
      );
      expect(run.status).toBe(201);
      const plan = run.body.plans[0];
      expect(plan).toBeTruthy();
      const approved = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${plan.planId}/approve`,
        {
          method: 'POST',
          headers: jsonHeaders(approverToken),
          body: JSON.stringify({ version: plan.version, snapshotVersion: plan.snapshotVersion }),
        },
      );
      expect(approved.status).toBe(200);
      const dispatched = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${plan.planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken), body: '{}' },
      );
      expect(dispatched.status).toBe(200);
      const before = await projection(fixture.orgA.id, plan.planId);
      // 前提断言：没有执行行，后面的"同进退"是空谈（同 V72"锁必须真的锁到 1 行"那条纪律）。
      expect(before.executions).toBeGreaterThan(0);
      expect(before.cancelledExecutions).toBe(0);
      console.log(`[${tag}] 派工后现场：${JSON.stringify(before)}`);
      return plan.planId;
    }

    function cancel(planId: string, reason: string) {
      return apiRequest<{ message?: string }>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/cancel`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ reason }),
        },
      );
    }

    it('PC-01 正常路径：取消把方案投影与执行跟踪一起落定', async () => {
      const org = fixture.orgA.id;
      const planId = await dispatchedPlan(`PC-01-${runId}`);
      const res = await cancel(planId, `e2e PC-01 基线取消 ${runId}`);
      expect(res.status).toBe(200);
      const after = await projection(org, planId);
      expect(after.planStatus).toBe('cancelled');
      expect(after.cancelledAssignments).toBe(after.assignments);
      expect(after.cancelledExecutions).toBe(after.executions);
      console.log(`[PC-01] 取消后：${JSON.stringify(after)}`);
    }, 180_000);

    it('PC-02 只让执行跟踪那次写入失败：方案投影会不会单独提交（现状实测）', async () => {
      const org = fixture.orgA.id;
      faultedPlanId = await dispatchedPlan(`PC-02-${runId}`);
      await owner.unsafe(`
        CREATE FUNCTION public.${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION '${FAULT}'; END;
        $fn$;
        CREATE TRIGGER ${TRIGGER}
        BEFORE UPDATE ON public.ewoh_scheduling_execution
        FOR EACH ROW WHEN (NEW.status = 'CANCELLED')
        EXECUTE FUNCTION public.${FN}();
      `);
      const res = await cancel(faultedPlanId, `e2e PC-02 执行跟踪被挡 ${runId}`);
      const after = await projection(org, faultedPlanId);
      const planMoved = after.planStatus === 'cancelled';
      const executionMoved = after.executions > 0 && after.cancelledExecutions === after.executions;
      console.log(
        `[PC-02] 注入唯一变量（只挡执行行→CANCELLED）后：http=${res.status} `
        + `planMoved=${planMoved} executionMoved=${executionMoved} 事实=${JSON.stringify(after)}`,
      );
      // 注释声称的性质＝"同进退"。这里断言的是实测到的那一侧：
      // 同一请求事务 ⇒ 取消整体回滚（HTTP 500、两处都没落定）。
      expect({ http: res.status, planMoved, executionMoved }).toEqual({
        http: 500, planMoved: false, executionMoved: false,
      });
      // 归因断言：那条 500 必须出自我们设的故障，而不是别的偶发失败——
      // 没有这条，"两处都没落定"可能只是取消半路被别的原因打断。
      // 归因断言：那条 500 必须**就是**执行跟踪那一次 UPDATE 抛的——错误面的 details 里
      // 带着失败语句本身（V102 实测：`Failed query: update "ewoh_scheduling_execution" ... params: CANCELLED`）。
      // 没有这条，"两处都没落定"可能只是取消被别的原因打断；配合 PC-03 撤障即 200 才是完整归因。
      const details = String((res.body as { error?: { details?: string } })?.error?.details ?? '');
      expect(details).toContain('update "ewoh_scheduling_execution"');
      expect(details).toContain('CANCELLED');
    }, 180_000);

    it('PC-03 反向控制与收尾：摘掉触发器后同一份方案能正常取消，且库里不留故障位点', async () => {
      const org = fixture.orgA.id;
      expect(faultedPlanId).toBeTruthy();
      await owner.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.ewoh_scheduling_execution;`);
      await owner.unsafe(`DROP FUNCTION IF EXISTS public.${FN}();`);
      const left = await owner`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = ${TRIGGER}`;
      expect(Number((left[0] as Record<string, unknown>).n)).toBe(0);

      const res = await cancel(faultedPlanId, `e2e PC-03 摘除故障后重跑取消 ${runId}`);
      expect(res.status).toBe(200);
      const after = await projection(org, faultedPlanId);
      expect(after.planStatus).toBe('cancelled');
      expect(after.cancelledExecutions).toBe(after.executions);
      console.log(`[PC-03] 唯一变量撤掉后：${JSON.stringify(after)}`);
    }, 180_000);

    /** 一张方案里全部 assignment 的权威态（从库里读，不信任响应体）。 */
    async function assignmentStates(org: string, planId: string) {
      const rows = await owner`SELECT assignment_id AS id, status
        FROM ewoh_scheduling_plan_assignment
        WHERE org_id::text = ${org} AND plan_id = ${planId} ORDER BY assignment_id`;
      return rows.map((r) => {
        const row = r as Record<string, unknown>;
        return { id: String(row.id), status: String(row.status) };
      });
    }

    /**
     * CCAS-01（V320）：取消级联的**逐条 CAS 是否真的在新版本上重判**，以及它落空时
     * 整笔事务是否**一点痕迹都不留**。V102 那三条（PC-01..03）钉的是"第二处写失败会不会
     * 单提交第一处"——那是**自身故障**；本例换的是**并发方推进**这一族，机制同 D-01/E-02：
     * 行锁就是同步接缝，不需要产品代码配合。
     *
     * 可行性来自实现本身（`plan.service.ts:885-968`）：
     *  · 分类读是无锁 select（:884-887），逐条写走 `cancelAssignmentByCAS`（谓词含
     *    `status = fromStatus`），0 命中 ⇒ 该条转入 irreversible；
     *  · 方案级 CAS 在**循环之后**才执行（:952-968，谓词是 `status IN (approved,dispatched,executing)`），
     *    0 命中 ⇒ 抛 `PLAN_CONCURRENT_CANCEL` ⇒ 整笔 `runInTransaction` 回滚。
     * ⇒ 外部会话分别锁住 assignment 行 / plan 行，就能把这两处各撑成一个可观测窗口。
     *
     * 三支判据：
     *  A 逐条腿重判：持锁者把那张 assignment 连带它的任务一起推进到 executing（照回执的形状写，
     *    不在库里留下半应用形态）并提交 ⇒ 取消必须 200 且把这张列入 irreversible、
     *    `cancelledAssignmentIds` 为空、这张 assignment 仍是 executing、它的执行跟踪不得被标 CANCELLED。
     *  B 方案腿重判：取消已把 assignment 改成 cancelled（未提交）、正卡在 plan 行的 CAS 上 ⇒
     *    持锁者把 plan.status 改成 cancelled 并提交 ⇒ 取消必须 409 `PLAN_CONCURRENT_CANCEL`，
     *    且**已写过的那些 assignment 逐字回到取消前**、执行跟踪 0 行 CANCELLED ——
     *    "另一个取消赢了竞赛"不许留下半取消。
     *  C 反证：把一条 assignment 手工改成 cancelled 再读同一判据 ⇒ 计数必须从 0 变 1，改回再变 0。
     *    没有这一支，A/B 里的 0 与恒真不可区分（V317 DRC-04 立的规矩，此处同一族）。
     */
    it('PC-04 取消级联的行锁窗口：逐条 CAS 与方案 CAS 都在新版本上重判，落空时整笔回滚不留半取消（CCAS-01）', async () => {
      const org = fixture.orgA.id;
      const holder = postgres(config!.ownerDatabaseUrl, { max: 1 });
      let windowA = { waited: false, probes: 0, waiters: 0 };
      let windowB = { waited: false, probes: 0, waiters: 0 };
      try {
        // ── A 逐条腿：assignment 行锁 ⇒ CAS 重判落空 ⇒ 转 irreversible ──
        const planA = await dispatchedPlan(`PC-04A-${runId}`);
        const targetsA = await assignmentStates(org, planA);
        // 前提断言：没有可分类的 assignment，"重判"这一问在本例结构上问不出来。
        expect(targetsA.length).toBeGreaterThan(0);
        const targetA = targetsA[0];
        expect(targetA.status).toBe('dispatched');

        await holder.unsafe('BEGIN');
        const lockedA = await holder.unsafe(
          `SELECT id FROM ewoh_scheduling_plan_assignment WHERE assignment_id = '${targetA.id}' FOR UPDATE`,
        );
        // 锁 0 行的 FOR UPDATE 不报错 ⇒ 必须当场数一行，否则会把"没人排队"伪装成构造成功。
        expect((lockedA as unknown[]).length).toBe(1);

        const cancelAPromise = cancel(planA, `e2e PC-04A 并发推进后取消 ${runId}`);
        windowA = await waitTupleLockQueued(holder, 'ewoh_scheduling_plan_assignment');
        expect(windowA.waited).toBe(true);
        // 连带把任务一起推进：只改 assignment 会在库里留下"assignment 推进而 task 未动"的
        // 半应用形态，那是别的用例的判据要扫的东西，不该由本例造出来。
        await holder.unsafe(
          `UPDATE ewoh_scheduling_plan_assignment SET status = 'executing' WHERE assignment_id = '${targetA.id}';`
          + `UPDATE ewoh_production_task SET status = 'executing' WHERE id::text = (`
          + `  SELECT task_id::text FROM ewoh_scheduling_plan_assignment WHERE assignment_id = '${targetA.id}');`,
        );
        await holder.unsafe('COMMIT');

        const cancelA = await cancelAPromise;
        // 响应体是 SchedulingPlanV2，取消的两个清单挂在 `cancel` 之下
        // （`scheduler-plan-application.service.ts:344-349` 读的就是 `plan.cancel?.cancelledAssignmentIds`）。
        // 直接从顶层取键会拿到 undefined ?? [] ⇒ "不含某 id"那一支会**假通过**，配对的那支才拦得住。
        const bodyA = ((cancelA.body as { cancel?: {
          cancelledAssignmentIds?: string[];
          irreversibleAssignmentIds?: string[];
        } } | undefined)?.cancel) ?? {};
        console.log(
          `${lockWindowNote('PC-04A', windowA, `推进到 executing 并提交 → http=${cancelA.status}`)} `
          + `cancelled=${JSON.stringify(bodyA.cancelledAssignmentIds ?? [])} `
          + `irreversible=${JSON.stringify(bodyA.irreversibleAssignmentIds ?? [])}`,
        );
        expect(cancelA.status).toBe(200);
        // 前提：两个清单至少有一边非空，否则"这张被列入哪一边"无从判。
        expect([
          ...(bodyA.cancelledAssignmentIds ?? []),
          ...(bodyA.irreversibleAssignmentIds ?? []),
        ].length).toBeGreaterThan(0);
        // ① 逐条腿的重判确实发生：并发方推进 ⇒ 这一项必须落进 irreversible，
        //    且库里那张 assignment 不许被取消写覆盖（这才是"状态已变则该条不可回退"那句注释的实测）。
        expect(bodyA.irreversibleAssignmentIds ?? []).toContain(targetA.id);
        const afterA = await assignmentStates(org, planA);
        expect(afterA.find((x) => x.id === targetA.id)?.status).toBe('executing');
        // 分叉的直接读数先打出来，再判互斥——红的时候日志里必须已经有"哪一行的执行跟踪被动了"。
        const orphanExec = (await owner`
          SELECT e.assignment_id AS id, e.status AS e_status, a.status AS a_status
            FROM ewoh_scheduling_execution e
            JOIN ewoh_scheduling_plan_assignment a ON a.assignment_id = e.assignment_id AND a.org_id = e.org_id
           WHERE e.plan_id = ${planA} AND e.status = 'CANCELLED' AND a.status <> 'cancelled'`) as
          Array<Record<string, unknown>>;
        const projA = await projection(org, planA);
        console.log(
          `[PC-04A] 库里事实：${JSON.stringify(afterA)} 投影=${JSON.stringify(projA)} `
          + `执行跟踪已 CANCELLED 而 assignment 未 cancelled 的行=${JSON.stringify(orphanExec)}`,
        );
        expect(orphanExec.length).toBe(0);
        // ② 两个清单必须互斥：CAS 落空 ⇒ 这一项**根本没被取消**，不许同时出现在 cancelled 里。
        //    它一旦被带出去，`cancelPlanV2:345-348` 就会把这张 assignment 交给
        //    `cancelForAssignments` 去标执行跟踪 ⇒ 留下 assignment=executing 而 execution=CANCELLED 的分叉。
        expect(bodyA.cancelledAssignmentIds ?? []).not.toContain(targetA.id);
        // 方案落终态；未被取消的那一张连它的执行跟踪都不许被动。
        expect(projA.planStatus).toBe('cancelled');
        expect(projA.cancelledAssignments).toBe(afterA.filter((x) => x.status === 'cancelled').length);
        expect(projA.cancelledExecutions).toBe(projA.cancelledAssignments);

        // ── B 方案腿：plan 行锁 ⇒ 方案 CAS 重判落空 ⇒ 整笔回滚 ──────────
        const planB = await dispatchedPlan(`PC-04B-${runId}`);
        const beforeB = await assignmentStates(org, planB);
        const projBeforeB = await projection(org, planB);
        await holder.unsafe('BEGIN');
        const lockedB = await holder.unsafe(
          `SELECT id FROM ewoh_schedule_plan WHERE plan_id = '${planB}' FOR UPDATE`,
        );
        expect((lockedB as unknown[]).length).toBe(1);

        const cancelBPromise = cancel(planB, `e2e PC-04B 并发取消抢先 ${runId}`);
        windowB = await waitTupleLockQueued(holder, 'ewoh_schedule_plan');
        expect(windowB.waited).toBe(true);
        // 让"另一个取消"赢：持锁者自己把方案落成 cancelled 并提交。
        // 方案级 CAS 的谓词是 status IN (approved,dispatched,executing) ⇒ 释放后必然 0 命中。
        await holder.unsafe(
          `UPDATE ewoh_schedule_plan SET status = 'cancelled', cancelled_reason = 'e2e PC-04B 抢先把方案取消' `
          + `WHERE plan_id = '${planB}';`,
        );
        await holder.unsafe('COMMIT');

        const cancelB = await cancelBPromise;
        const rawB = cancelB.body as {
          message?: string; error?: { code?: string; message?: string };
        } | undefined;
        const codeB = String(rawB?.error?.message ?? rawB?.message ?? rawB?.error?.code ?? '');
        console.log(
          `${lockWindowNote('PC-04B', windowB, `持锁者抢先取消并提交 → http=${cancelB.status}`)} code=${codeB}`,
        );
        expect(cancelB.status).toBe(409);
        // 归因断言：409 必须出自"方案 CAS 落空"那一句，而不是别的偶发失败。
        expect(codeB).toContain('PLAN_CONCURRENT_CANCEL');
        const afterB = await assignmentStates(org, planB);
        expect(afterB).toEqual(beforeB);
        const projB = await projection(org, planB);
        expect(projB.planStatus).toBe('cancelled');
        // 半取消为零：整笔回滚 ⇒ 取消计数逐字停在取消之前那一刻。
        expect(projB.cancelledAssignments).toBe(projBeforeB.cancelledAssignments);
        expect(projB.cancelledExecutions).toBe(projBeforeB.cancelledExecutions);

        // ── C 反证支：上面那两个 0 不是恒真 ───────────────────────────
        const victim = afterB[0];
        expect(await projection(org, planB)).toEqual(projB);
        await owner.unsafe(
          `UPDATE ewoh_scheduling_plan_assignment SET status = 'cancelled' WHERE assignment_id = $1`,
          [victim.id],
        );
        const violated = await projection(org, planB);
        console.log(
          `[PC-04C] 手工把一条 assignment 改成 cancelled ⇒ cancelledAssignments `
          + `${projB.cancelledAssignments}→${violated.cancelledAssignments}（必须变，否则 B 支那句"0 半取消"是恒真的）`,
        );
        expect(violated.cancelledAssignments).toBe(projB.cancelledAssignments + 1);
        await owner.unsafe(
          `UPDATE ewoh_scheduling_plan_assignment SET status = 'dispatched' WHERE assignment_id = $1`,
          [victim.id],
        );
        expect((await projection(org, planB)).cancelledAssignments).toBe(projB.cancelledAssignments);
      } finally {
        await holder.end({ timeout: 5 });
      }
    }, 300_000);
  },
);
