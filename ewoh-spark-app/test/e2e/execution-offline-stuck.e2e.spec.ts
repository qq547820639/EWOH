/**
 * 试点链行为基线：执行阶段的「断网」列（真实 Nest + 真实 PostgreSQL）。
 *
 * 为什么要单独测这一格：矩阵的「执行／断网」此前只到"孤立命令不投递"（P-01 测的是**派工**
 * 阶段断网）。真正没测过的是另一半：**现场已经开工，然后永远不再回来**——
 * 设备掉电、工人离职、边缘进程被杀都会落在这里。这一格决定一件事：
 * 「派工成功」之后平台是否对**结果**负有收敛责任，还是只负责把事实记成"已派工"。
 *
 * 本例只观测既有行为，不改产品代码。结论（实测）：**没有任何收敛**——
 * 执行词表是封闭的（`execution-receipt-state.ts` 的 PLANNED/DISPATCHED/STARTED/PAUSED/
 * COMPLETED/FAILED/CANCELLED 里没有"过期/失踪"这一类），全仓没有任何针对 execution 的
 * 定时器/Cron/年龄阈值 SQL，而命令面的 `expired` 与执行面**没有连接键**
 * （`ewoh_control_command` 根本没有 assignment_id/task_id 列，见 schema.ts:2810-2852），
 * 所以就算过期被判定，也没有任何东西能把这条事实传回执行侧。
 */
import type { SchedulingPlanV2 } from '../../shared/api.interface';
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

type Posture = Record<string, unknown>;

/** 现场失踪后要核对的八项事实（一次查询取全，前后对照只差时间）。 */
async function readPosture(
  owner: OwnerSql,
  org: string,
  assignmentId: string,
  taskId: string,
): Promise<Posture> {
  const rows = await owner`
    SELECT
      (SELECT e.status FROM ewoh_scheduling_execution e
         WHERE e.org_id::text = ${org} AND e.assignment_id = ${assignmentId}) AS exec_status,
      (SELECT e.actual_end_at IS NOT NULL FROM ewoh_scheduling_execution e
         WHERE e.org_id::text = ${org} AND e.assignment_id = ${assignmentId}) AS exec_has_end,
      (SELECT e.deviation_type FROM ewoh_scheduling_execution e
         WHERE e.org_id::text = ${org} AND e.assignment_id = ${assignmentId}) AS deviation_type,
      (SELECT e.source FROM ewoh_scheduling_execution e
         WHERE e.org_id::text = ${org} AND e.assignment_id = ${assignmentId}) AS exec_source,
      (SELECT a.status FROM ewoh_scheduling_plan_assignment a
         WHERE a.org_id::text = ${org} AND a.assignment_id = ${assignmentId}) AS assignment_status,
      (SELECT t.status FROM public.ewoh_production_task t
         WHERE t.org_id::text = ${org} AND t.id = ${taskId}) AS task_status,
      (SELECT count(*)::int FROM ewoh_resource_reservation r
         WHERE r.org_id::text = ${org} AND r.assignment_id = ${assignmentId}
           AND r.status <> 'released') AS active_reservations,
      (SELECT count(*)::int FROM ewoh_scheduling_feedback f
         WHERE f.org_id::text = ${org} AND f.assignment_id = ${assignmentId}) AS feedback_rows,
      -- feedback 行在"开工"时就建好（不是完工才建）：这里核它对账半边是否为空。
      (SELECT f.actual_end IS NOT NULL FROM ewoh_scheduling_feedback f
         WHERE f.org_id::text = ${org} AND f.assignment_id = ${assignmentId} LIMIT 1) AS fb_has_end,
      (SELECT f.production_training_eligible FROM ewoh_scheduling_feedback f
         WHERE f.org_id::text = ${org} AND f.assignment_id = ${assignmentId} LIMIT 1) AS fb_training_eligible,
      (SELECT f.accepted FROM ewoh_scheduling_feedback f
         WHERE f.org_id::text = ${org} AND f.assignment_id = ${assignmentId} LIMIT 1) AS fb_accepted,
      (SELECT count(*)::int FROM ewoh_assignment_event v
         WHERE v.org_id::text = ${org} AND v.assignment_id = ${assignmentId}) AS assignment_events,
      (SELECT count(*)::int FROM ewoh_control_request q
         WHERE q.org_id::text = ${org}) AS control_requests`;
  return rows[0] as Posture;
}

(config ? describe : describe.skip)(
  '执行×断网基线 E2E（真实 PostgreSQL：开工后现场永远不回来）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let dispatcherToken = '';
    let approverToken = '';

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      resources = await seedSchedulerFixture(owner, fixture.orgA.id);
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
    }, 60_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    it('X-01 开工后断网：八项事实在巡检与稳定窗口之后全部停在"进行中"，没有任何出口', async () => {
      const org = fixture.orgA.id;
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'MANUAL',
            entityId: resources.taskId,
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
      const dispatched = await apiRequest(
        handle.baseUrl,
        `/api/scheduler/plans/${plan.planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken), body: '{}' },
      );
      expect(dispatched.status).toBe(200);

      const assignment = plan.assignments[0];
      const assignmentId = assignment.assignmentId;
      const taskId = String(assignment.taskId ?? resources.taskId);

      // 「开工」走现场回执面（人/设备任一入口都行，这里用特权角色，不需要边缘在场）。
      const started = await apiRequest(
        handle.baseUrl,
        `/api/scheduler/executions/${assignmentId}/update`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            status: 'STARTED',
            actualStartAt: new Date().toISOString(),
          }),
        },
      );
      // 该路由无 @HttpCode ⇒ POST 默认 201（与 reject/replan 同一形态）。
      expect(started.status).toBe(201);

      const before = await readPosture(owner, org, assignmentId, taskId);
      expect(String(before.exec_status)).toBe('STARTED');
      expect(String(before.assignment_status)).toBe('executing');
      expect(String(before.task_status)).toBe('executing');
      // 预占是派工产生的（唯一生产者 dispatch-coordinator.service.ts:602）——
      // 现场失踪时它仍占着资源，这才是"资源生命周期"的一半问题。
      expect(Number(before.active_reservations)).toBeGreaterThan(0);
      // 断网世界的另一半前提：这一路根本没有控制面命令可过期。
      expect(Number(before.control_requests)).toBe(0);

      // 唯一的收敛机制是命令面巡检（F-02）；这里显式跑两次，中间隔一个稳定窗口。
      const sweep1 = await apiRequest(
        handle.baseUrl,
        '/api/control/delivery-backlog/sweep',
        { method: 'POST', headers: jsonHeaders(dispatcherToken) },
      );
      expect(sweep1.status).toBeLessThan(500);
      await new Promise((r) => setTimeout(r, 10_000));
      const sweep2 = await apiRequest(
        handle.baseUrl,
        '/api/control/delivery-backlog/status',
        { headers: jsonHeaders(dispatcherToken) },
      );
      expect(sweep2.status).toBeLessThan(500);

      const after = await readPosture(owner, org, assignmentId, taskId);
      console.log(
        `[X-01] 开工后断网（10s + 两次巡检面调用之后）：`
        + `exec=${String(before.exec_status)}→${String(after.exec_status)} `
        + `有结束时间=${String(before.exec_has_end)}→${String(after.exec_has_end)} `
        + `deviation=${String(before.deviation_type)}→${String(after.deviation_type)} `
        + `assignment=${String(before.assignment_status)}→${String(after.assignment_status)} `
        + `task=${String(before.task_status)}→${String(after.task_status)} `
        + `未释放预占=${Number(before.active_reservations)}→${Number(after.active_reservations)} `
        + `feedback行=${Number(before.feedback_rows)}→${Number(after.feedback_rows)} `
        + `（有 actual_end=${String(after.fb_has_end)}，可入训练=${String(after.fb_training_eligible)}，`
        + `accepted=${String(after.fb_accepted)}） `
        + `assignment事件=${Number(before.assignment_events)}→${Number(after.assignment_events)} `
        + `控制面请求=${Number(before.control_requests)}→${Number(after.control_requests)}`,
      );

      // 八项事实逐项不变：这是"没有出口"的实测形式，不是"我们没找到出口"。
      for (const key of Object.keys(before)) {
        expect([key, after[key]]).toEqual([key, before[key]]);
      }
      // 也没有任何"过期/失踪"类词被写出来（执行词表是封闭的，见文件头）。
      expect(String(after.exec_status)).toBe('STARTED');
      expect(String(after.exec_has_end)).toBe('false');
      expect(after.deviation_type).toBeNull();
      // 实测修正：feedback 行**开工时就建好**（不是完工才建），于是它带着半具事实永存——
      // `actual_end` 空、`accepted` 空，KPI/学习信号侧的查询因此永远看不到这条工作项的结果。
      expect(Number(after.feedback_rows)).toBe(1);
      expect(String(after.fb_has_end)).toBe('false');
      expect(after.fb_accepted).toBeNull();
    }, 120_000);

    /**
     * X-02（V104 新增）：现场失踪的执行在 KPI 投影里**留在分母**。
     *
     * 起因：F-13 的登记文字里有一句「半具 feedback 行会被 KPI/学习侧当成有数据」——那是走读得到的推论。
     * 本例把它换成读数：`kpi.service.ts:124-127` 的完成率是
     * `COMPLETED 行数 / periodExec 行数`，没有终态的执行既不进分子也不被剔除 ⇒ 指标只降不升、
     * 而且没有任何字段告诉运维"为什么降"。
     * 三步：① KPI 读数与库内比值必须相等（证明投影就是照这个口径算的）；
     * ② 现场仍有 STARTED 行时读数必须 < 1（前提）；③ 让那条失踪执行真的回来（今天唯一的出口）后读数回到 1
     * —— 这一步是归因：缺口整块来自那一行，而不是时段/租户口径。
     */
    it('X-02 KPI 投影：永不终态的执行留在分母，完成率只降不升（实测 F-13 的下游后果）', async () => {
      const org = fixture.orgA.id;
      const ratio = async () => {
        const rows = await owner`
          select count(*) filter (where status = 'COMPLETED')::float / nullif(count(*), 0) as rate,
                 count(*) filter (where status = 'STARTED')::int as started,
                 count(*)::int as total
            from public.ewoh_scheduling_execution where org_id::text = ${org}`;
        return rows[0] as Record<string, unknown>;
      };
      const kpi = async () => {
        const res = await apiRequest<{ delivery?: { completionRate?: number | null } }>(
          handle.baseUrl, '/api/scheduler/kpi', { headers: jsonHeaders(dispatcherToken) },
        );
        expect(res.status).toBe(200);
        return res.body?.delivery?.completionRate;
      };

      const rate0 = await kpi();
      const db0 = await ratio();
      console.log(
        `[X-02] 失踪现场仍在时：KPI completionRate=${String(rate0)} `
        + `库内 COMPLETED/total=${String(db0.rate)}（STARTED=${String(db0.started)}/total=${String(db0.total)}）`,
      );
      // 前提：本 org 确有未终态执行（X-01 留下的现场），否则后面两句都是空断言。
      expect(Number(db0.started)).toBeGreaterThan(0);
      expect(typeof rate0).toBe('number');
      // ① 投影与来源同口径
      expect(Number(rate0)).toBeCloseTo(Number(db0.rate), 9);
      // ② 该行为留在分母 ⇒ 指标被压低
      expect(Number(rate0)).toBeLessThan(1);

      const stuck = await owner`
        select assignment_id as "assignmentId" from public.ewoh_scheduling_execution
         where org_id::text = ${org} and status = 'STARTED' order by assignment_id limit 1`;
      const assignmentId = String((stuck[0] as Record<string, unknown>).assignmentId);
      // 已登记的实测事实是不可覆写的（`execution-receipt-application.service.ts:136`：
      // 同一字段带了不同时间戳 ⇒ 409 RECEIPT_FEEDBACK_FACT_CONFLICT）。
      // 本例第一版就是自己编了一个 actualStartAt 而被这道守卫挡住——那是守卫正确、探针错。
      const stored = await owner`
        select actual_start_at as "actualStartAt" from public.ewoh_scheduling_execution
         where org_id::text = ${org} and assignment_id = ${assignmentId}`;
      const storedStart = (stored[0] as Record<string, unknown>).actualStartAt;
      expect(storedStart).toBeTruthy();
      const done = await apiRequest(
        handle.baseUrl, `/api/scheduler/executions/${assignmentId}/update`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            status: 'COMPLETED',
            actualStartAt: new Date(storedStart as string).toISOString(),
            actualEndAt: new Date().toISOString(),
          }),
        },
      );
      console.log(`[X-02] 让失踪执行回来的调用：status=${done.status} body=${JSON.stringify(done.body).slice(0, 220)}`);
      expect([200, 201]).toContain(done.status);

      const rate1 = await kpi();
      const db1 = await ratio();
      console.log(
        `[X-02] 让失踪执行真的回来之后：KPI completionRate=${String(rate1)} 库内=${String(db1.rate)} `
        + `（STARTED=${String(db1.started)}/total=${String(db1.total)}）`,
      );
      // ③ 归因闭合：缺口整块来自那一行
      expect(Number(rate1)).toBeCloseTo(Number(db1.rate), 9);
      expect(Number(rate1)).toBe(1);
      expect(Number(db1.started)).toBe(0);
    }, 120_000);
  },
);
