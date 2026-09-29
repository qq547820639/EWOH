/**
 * 重排路径会不会把**已派工**的方案静默作废（V157，GUARD-01 现状读数）。
 *
 * 发现路径：新量具 `scripts/chain-baseline/status-write-guard-census.cjs` 在链上 24 处
 * "写 status 的产品面 UPDATE"里只挑出 2 处**没有来源态谓词**：一处是 V156 的 run 闭合（RUN-02），
 * 另一处是 `plan.service.ts:1400-1403` —— replan 把旧方案改写成 `superseded`：
 * ```ts
 * .set({ status: 'superseded', supersededBy: newPlanId }).where(eq(ewohSchedulePlan.planId, planId))
 * ```
 * 读码三条事实：①`replan()` 只校验"方案存在"（`NotFoundException`），**不校验旧方案当前状态**；
 * ②写侧谓词只有 `plan_id`（连 org 谓词都没有，隔离靠 RLS，而 `org_id` 可空=全局/存量行由 policy 放行）；
 * ③`contracts/state-machines/plan.yaml` 的 transitions 里**根本没有 `superseded`**（⇒ F-11/GATE-21 词表口径）。
 *
 * 本文件要的不是"这是缺陷"，而是**这条路径今天到底走到哪一步**：已派工的方案被重排后，
 * 方案行与它的执行/预占投影是否还同进退。结论若与"设计如此"不符，交属主裁（GUARD-01）。
 *
 * 档位：常驻 spec、CI 的 `npm run test:e2e` glob 会跑；**未列入 CHAIN_SPECS**（V112 同类，T2 常驻·重放外）。
 * 本文件只观测既有行为，不改产品代码。
 */
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
  type E2EFixture,
  type OwnerSql,
  type SchedulerFixture,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';

const config = resolveE2EConfig();

(config ? describe : describe.skip)(
  'replan 对已派工方案的作废语义（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let token: string;
    let approverToken: string;
    const originalWorkerUrl = process.env.CPSAT_WORKER_URL;
    const originalActivation = process.env.EWOH_SOLVER_ACTIVATION;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });
    beforeEach(async () => {
      fixture = await createE2EFixture(owner);
      resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      // 与 concurrency-real-pg 同一纪律：把求解器钉成"必然走启发式"，不依赖外部 CP-SAT 服务
      process.env.CPSAT_WORKER_URL = 'http://127.0.0.1:1';
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const dispatcher = await login(handle.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password);
      expect(dispatcher.status).toBe(201);
      token = dispatcher.body.accessToken;
      const approver = await login(handle.baseUrl, fixture.approverA.username, fixture.approverA.password);
      expect(approver.status).toBe(201);
      approverToken = approver.body.accessToken;
    });
    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        process.env.CPSAT_WORKER_URL = originalWorkerUrl;
        process.env.EWOH_SOLVER_ACTIVATION = originalActivation;
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
    });
    afterAll(async () => {
      await owner?.end();
    });

    async function createApprovedPlan(): Promise<string> {
      const run = await apiRequest<{ plans: Array<{ planId: string; version: number; snapshotVersion: number }> }>(
        handle.baseUrl, '/api/scheduler/runs',
        { method: 'POST', headers: jsonHeaders(token),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: resources.taskId }) });
      expect(run).toMatchObject({ status: 201, body: { debounced: false } });
      const plan = run.body.plans[0];
      expect(plan).toBeTruthy();
      const approve = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${plan.planId}/approve`,
        { method: 'POST', headers: jsonHeaders(approverToken),
          body: JSON.stringify({ version: plan.version, snapshotVersion: plan.snapshotVersion }) });
      expect(approve.status).toBe(200);
      return plan.planId;
    }

    const projections = async (planId: string) => ({
      plan: (await owner`SELECT status, superseded_by FROM ewoh_schedule_plan
                WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${planId}`) as
        Array<{ status: string; superseded_by: string | null }>,
      executions: await owner`SELECT assignment_id FROM ewoh_scheduling_execution
                WHERE org_id = ${fixture.orgA.id} AND plan_id = ${planId}`,
      reservations: await owner`SELECT reservation_id FROM ewoh_resource_reservation
                WHERE org_id = ${fixture.orgA.id} AND plan_id = ${planId}`,
    });

    it('GUARD-P01: approved→dispatched 后 replan ⇒ HTTP 结果 + 方案状态 + 执行/预占投影是否同进退', async () => {
      const planId = await createApprovedPlan();
      const dispatch = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(token) });
      expect(dispatch.status).toBe(200);
      const afterDispatch = await projections(planId);
      expect(afterDispatch.plan[0]?.status).toBe('dispatched');
      expect(afterDispatch.executions.length).toBeGreaterThan(0);
      const reservationsBefore = afterDispatch.reservations.length;

      const replan = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${planId}/replan`,
        { method: 'POST', headers: jsonHeaders(token),
          body: JSON.stringify({ lockedConstraints: [], reason: 'V157：已派工方案能否被重排作废' }) });
      const afterReplan = await projections(planId);
      // 原始读数（两条都可能， whichever 发生都要写进台账，不许挑好看的报）
      console.log(`GUARD-P01 读数：replan status=${replan.status} `
        + `body=${JSON.stringify(replan.body).slice(0, 160)} `
        + `方案状态=${afterReplan.plan[0]?.status} superseded_by=${afterReplan.plan[0]?.superseded_by} `
        + `执行行=${afterReplan.executions.length} 预占行=${afterReplan.reservations.length}（重排前 ${reservationsBefore}）`);
      expect([200, 201, 400, 403, 409]).toContain(replan.status);
    });

    it('GUARD-P02: 写侧对旧方案当前状态完全不挑？——把已取消的方案再 replan 一次看结果', async () => {
      const planId = await createApprovedPlan();
      const cancel = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${planId}/cancel`,
        { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ reason: 'V157 对照' }) });
      expect(cancel.status).toBe(200);
      const cancelled = await projections(planId);
      expect(cancelled.plan[0]?.status).toBe('cancelled');

      const replan = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${planId}/replan`,
        { method: 'POST', headers: jsonHeaders(token),
          body: JSON.stringify({ lockedConstraints: [], reason: 'V157：cancelled 方案能否被重排' }) });
      const after = await projections(planId);
      console.log(`GUARD-P02 读数：replan(cancelled) status=${replan.status} `
        + `body=${JSON.stringify(replan.body).slice(0, 160)} 方案状态=${after.plan[0]?.status}`);
      expect([200, 201, 400, 403, 409]).toContain(replan.status);
    });
  },
);
