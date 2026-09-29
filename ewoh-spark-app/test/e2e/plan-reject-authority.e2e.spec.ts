/**
 * 试点链行为基线：调度阶段的「拒绝」列（真实 Nest + 真实 PostgreSQL）。
 *
 * 为什么要单独测这一格：矩阵里的「调度／拒绝」此前只有 `PLAN_STALE`（approve 撞过期快照），
 * 而**驳回**这条边从来没有 e2e 覆盖——`test/e2e/**` 与 `scripts/**` 里没有任何用例打
 * `POST /api/scheduler/plans/:id/reject`。这条边恰好落在两套既有登记的交叉口：
 *  - `contracts/state-machines/plan.yaml` 根本没有 `rejected` 状态（V60 棘轮的 4 个欠账词之一），
 *    驳回语义在契约里写的是 `pending_review → shadow / reject_and revise`；
 *  - 批准权威并存（F-11：`approved` 与 `confirmed` 两套名字）。
 * 所以本例要回答的不是"reject 返回 200 吗"，而是：**拒绝写掉了什么事实、没写什么事实、
 * 以及这条终态会不会被后面的动作改写**。
 *
 * 结论口径：RJ-02 是「现状钉住」用例——它断言的是**实测到的现有行为**，
 * 如果将来判定该行为不对并修掉，必须同时翻转这条断言（与 S-03 在 RUN-01 修复时的手法一致）。
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

// 跨用例共享：RJ-02 的对象就是 RJ-01 驳回的那份方案（顺序执行，--runInBand）。
let owner: OwnerSql;
let fixture: E2EFixture;
let resources: SchedulerFixture;
let handle: E2EAppHandle;
let dispatcherToken = '';
let approverToken = '';
let rejectedPlanId = '';
let approvedPlanId = '';

(config ? describe : describe.skip)(
  '调度×拒绝基线 E2E（真实 PostgreSQL：驳回写了什么、没写什么、会不会被改写）',
  () => {
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

    it('RJ-01 驳回的事实面与不牵连面：方案=唯一被改写的权威，任务/预占/出站事实一概不动', async () => {
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
      expect(plan).toBeTruthy();
      const planId = plan.planId;
      rejectedPlanId = planId;
      // 驳回只接受 draft/shadow/proposed（plan.service.ts:783-788）——先确认前提成立。
      expect(['draft', 'shadow', 'proposed']).toContain(plan.status);

      const taskBefore = await owner`
        SELECT status, version FROM public.ewoh_production_task
         WHERE org_id::text = ${org} AND id = ${resources.taskId}`;
      // 出站面用"驳回前后之差"计：run 本身可能已为该方案写过 outbox 事件。
      const outboxBefore = await owner`
        SELECT count(*)::int AS n FROM ewoh_outbox o
         WHERE o.org_id::text = ${org} AND o.entity_id = ${planId}`;

      const rejected = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/reject`,
        {
          method: 'POST',
          headers: jsonHeaders(approverToken),
          body: JSON.stringify({ reason: 'e2e RJ-01 基线驳回' }),
        },
      );
      // reject/replan 两条路由都没有 @HttpCode(200)（对照 approve 有），POST 默认 201。
      expect(rejected.status).toBe(201);
      expect(String(rejected.body.status)).toBe('rejected');

      const facts = await owner`
        SELECT
          (SELECT p.status FROM ewoh_schedule_plan p
             WHERE p.org_id::text = ${org} AND p.plan_id = ${planId}) AS plan_status,
          (SELECT count(*)::int FROM ewoh_schedule_plan p
             WHERE p.org_id::text = ${org} AND p.plan_id = ${planId}) AS plan_rows,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${planId}
               AND a.status = 'cancelled') AS cancelled_assignments,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${planId}
               AND a.status <> 'cancelled') AS live_assignments,
          (SELECT count(*)::int FROM ewoh_schedule_audit s
             WHERE s.org_id::text = ${org} AND s.plan_id = ${planId}
               AND s.action = 'reject') AS reject_audit_rows,
          (SELECT count(*)::int FROM ewoh_resource_reservation r
             WHERE r.org_id::text = ${org} AND r.plan_id = ${planId}) AS reservations,
          (SELECT count(*)::int FROM ewoh_scheduling_execution e
             WHERE e.org_id::text = ${org} AND e.plan_id = ${planId}) AS executions,
          (SELECT t.status FROM public.ewoh_production_task t
             WHERE t.org_id::text = ${org} AND t.id = ${resources.taskId}) AS task_status`;
      const f = facts[0] as Record<string, unknown>;
      expect(String(f.plan_status)).toBe('rejected');
      expect(Number(f.plan_rows)).toBe(1);
      // 驳回把 assignment 全部置 cancelled（plan.service.ts:818-828）。
      expect(Number(f.cancelled_assignments)).toBe(plan.assignments.length);
      expect(Number(f.live_assignments)).toBe(0);
      // 审计：一份方案一次驳回 = 1 行（幂等面在下一步用 HTTP 再验）。
      expect(Number(f.reject_audit_rows)).toBe(1);
      // 「不牵连」的三条：预占只在派工时产生（reserve 唯一调用点
      // dispatch-coordinator.service.ts:602），故未派工的驳回本就没有可泄漏的预占；
      // execution 只在派工时写；任务状态不被驳回改写。
      expect(Number(f.reservations)).toBe(0);
      expect(Number(f.executions)).toBe(0);
      expect(String(f.task_status)).toBe(String((taskBefore[0] as Record<string, unknown>).status));

      // 出站/投影面：驳回不新增任何 outbox 事件（对照 cancelPlan 会写 PlanCancelled，
      // 见 plan.service.ts:1019 的 outbox 'PlanCancelled'）——所以"这份方案被驳回了"对 SSE/下游是不可见的。
      const outboxAfter = await owner`
        SELECT count(*)::int AS n FROM ewoh_outbox o
         WHERE o.org_id::text = ${org} AND o.entity_id = ${planId}`;
      const outboxDelta = Number((outboxAfter[0] as Record<string, unknown>).n)
        - Number((outboxBefore[0] as Record<string, unknown>).n);
      expect(outboxDelta).toBe(0);

      // 读侧投影：驳回后既不在 active-plans，也不在 conflicts 的活跃集合里。
      const active = await apiRequest<unknown>(
        handle.baseUrl,
        '/api/scheduler/active-plans',
        { headers: jsonHeaders(dispatcherToken) },
      );
      expect(active.status).toBe(200);
      expect(JSON.stringify(active.body)).not.toContain(planId);

      // 重复驳回：状态谓词把它挡在门外（CAS 之外还有 rejectable 前置）。
      const again = await apiRequest<{ message?: string }>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/reject`,
        {
          method: 'POST',
          headers: jsonHeaders(approverToken),
          body: JSON.stringify({ reason: 'e2e RJ-01 二次驳回' }),
        },
      );
      expect(again.status).toBe(409);
      const auditAfter = await owner`
        SELECT count(*)::int AS n FROM ewoh_schedule_audit s
         WHERE s.org_id::text = ${org} AND s.plan_id = ${planId} AND s.action = 'reject'`;
      expect(Number((auditAfter[0] as Record<string, unknown>).n)).toBe(1);

      // 被驳回的方案不能再派工（派工只认 approved）。
      const dispatched = await apiRequest<{ message?: string }>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken), body: '{}' },
      );
      expect(dispatched.status).toBe(409);

      console.log(
        `[RJ-01] 驳回事实面：plan=${String(f.plan_status)} assignment `
        + `cancelled=${Number(f.cancelled_assignments)}/${plan.assignments.length} `
        + `reject审计=${Number(f.reject_audit_rows)} 预占=${Number(f.reservations)} `
        + `execution=${Number(f.executions)} 任务状态=${String(f.task_status)} `
        + `outbox 增量=${outboxDelta} 二次驳回=${again.status} `
        + `派工=${dispatched.status} ${String((dispatched.body as { message?: string })?.message ?? '').slice(0, 60)}`,
      );
    }, 120_000);

    it('RJ-02 终态改写实测：驳回后 replan 会把 rejected 无条件改成 superseded（现状钉住）', async () => {
      const org = fixture.orgA.id;
      const planId = rejectedPlanId;
      expect(planId).toBeTruthy();

      // replan 入口只有「存在 + 租户可见」两道前置（plan.service.ts:1272-1279），
      // **没有任何状态前置**；旧方案的 supersede 写入是 `where plan_id`（:1400-1403，
      // 无 status 谓词、无 version 谓词、无 .returning()、不检查命中）。
      const replanned = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ lockedConstraints: [], reason: 'e2e RJ-02 驳回后重排' }),
        },
      );
      const after = await owner`
        SELECT status, superseded_by AS "supersededBy", version
          FROM ewoh_schedule_plan WHERE org_id::text = ${org} AND plan_id = ${planId}`;
      const row = after[0] as Record<string, unknown>;
      const newPlanId = replanned.status < 400
        ? String((replanned.body as SchedulingPlanV2).planId)
        : '';

      console.log(
        `[RJ-02] 驳回后 replan：HTTP=${replanned.status} `
        + `新方案=${newPlanId || '-'} 被驳回方案现在=${String(row?.status)} `
        + `superseded_by=${String(row?.supersededBy ?? '-')} version=${String(row?.version ?? '-')}`,
      );

      // 现状钉住（不是"应该如此"）：驳回在这条链上**不是**终态——重排成功并且
      // 旧方案被改写成 superseded，"这份方案被谁驳回"只剩审计表里那一行。
      expect(replanned.status).toBe(201);
      expect(String(row?.status)).toBe('superseded');
      expect(String(row?.supersededBy)).toBe(newPlanId);

      // 新方案是可批准的正常起点（version 递增、状态回到可批面）。
      expect(['draft', 'shadow', 'proposed']).toContain(
        String((replanned.body as SchedulingPlanV2).status),
      );
      expect((replanned.body as SchedulingPlanV2).version).toBe(
        Number(row?.version) + 1,
      );

      // 权威边界对照：一旦新方案被批准，reject 就不再是它的出口（只能走 cancel）。
      const approvedPlan = replanned.body as SchedulingPlanV2;
      const approved = await apiRequest(
        handle.baseUrl,
        `/api/scheduler/plans/${approvedPlan.planId}/approve`,
        {
          method: 'POST',
          headers: jsonHeaders(approverToken),
          body: JSON.stringify({
            version: approvedPlan.version,
            snapshotVersion: approvedPlan.snapshotVersion,
          }),
        },
      );
      expect(approved.status).toBe(200);
      const rejectAfterApprove = await apiRequest<{ message?: string }>(
        handle.baseUrl,
        `/api/scheduler/plans/${approvedPlan.planId}/reject`,
        {
          method: 'POST',
          headers: jsonHeaders(approverToken),
          body: JSON.stringify({ reason: 'e2e RJ-02 批准后再驳回' }),
        },
      );
      expect(rejectAfterApprove.status).toBe(409);
      const stillApproved = await owner`
        SELECT status FROM ewoh_schedule_plan
         WHERE org_id::text = ${org} AND plan_id = ${approvedPlan.planId}`;
      expect(String((stillApproved[0] as Record<string, unknown>).status)).toBe('approved');
      approvedPlanId = approvedPlan.planId;

      console.log(
        `[RJ-02] 权威边界：批准后再 reject=${rejectAfterApprove.status} `
        + `（方案状态仍为 ${String((stillApproved[0] as Record<string, unknown>).status)}）`,
      );
    }, 120_000);

    /**
     * RJ-03：把 RJ-02 的形态推到**已派工**的方案上——同一处无状态前置的 replan 写入，
     * 后果不再是"驳回痕迹消失"，而是**方案投影与执行权威分叉**：
     * plan 被改成 superseded，而它的 assignment / execution / 预占仍在现场生效。
     * 这一格不需要并发：只要「顺序 approve → dispatch → replan」就能复现，
     * 因此它是可重放的事实，不是竞态推定（对照 §5.3c 对不可复现假设的处理）。
     * 归属：**F-12**（被拒／已派工的方案能不能重排、在飞 assignment/预占归谁——见
     *   《链级行为基线》§5.4 F-12 与《裁决包》§四·补 R5）。V174 的"钉现状断言"普查发现本块标了
     *   「现状实测」却没自标编号 ⇒ 按编号检索会漏掉这条现状面，此处就地补标（注释级改动，零行为变化）。
     */
    it('RJ-03 已派工方案被 replan：方案投影与执行权威是否分叉（现状实测）', async () => {
      const org = fixture.orgA.id;
      const planId = approvedPlanId;
      expect(planId).toBeTruthy();

      const dispatched = await apiRequest<{ dispatchedAssignments?: number }>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken), body: '{}' },
      );
      expect(dispatched.status).toBe(200);

      const before = await owner`
        SELECT
          (SELECT status FROM ewoh_schedule_plan
             WHERE org_id::text = ${org} AND plan_id = ${planId}) AS plan_status,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${planId}
               AND a.status = 'dispatched') AS live_assignments,
          (SELECT count(*)::int FROM ewoh_scheduling_execution e
             WHERE e.org_id::text = ${org} AND e.plan_id = ${planId}) AS executions,
          (SELECT count(*)::int FROM ewoh_resource_reservation r
             WHERE r.org_id::text = ${org} AND r.plan_id = ${planId}
               AND r.status <> 'released') AS active_reservations`;
      const b = before[0] as Record<string, unknown>;
      expect(String(b.plan_status)).toBe('dispatched');
      expect(Number(b.executions)).toBeGreaterThan(0);
      expect(Number(b.live_assignments)).toBeGreaterThan(0);
      // 预占唯一生产者就是派工（dispatch-coordinator.service.ts:602）——RJ-01 的"驳回不泄漏预占"
      // 正是建立在"未派工没有预占"这一点上，这里把它变成实测前提而不是走读推定。
      expect(Number(b.active_reservations)).toBeGreaterThan(0);

      const replanned = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${planId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ lockedConstraints: [], reason: 'e2e RJ-03 对已派工方案重排' }),
        },
      );

      const after = await owner`
        SELECT
          (SELECT p.status FROM ewoh_schedule_plan p
             WHERE p.org_id::text = ${org} AND p.plan_id = ${planId}) AS plan_status,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${planId}
               AND a.status = 'dispatched') AS live_assignments,
          (SELECT count(*)::int FROM ewoh_scheduling_execution e
             WHERE e.org_id::text = ${org} AND e.plan_id = ${planId}) AS executions,
          (SELECT count(*)::int FROM ewoh_resource_reservation r
             WHERE r.org_id::text = ${org} AND r.plan_id = ${planId}
               AND r.status <> 'released') AS active_reservations`;
      const a = after[0] as Record<string, unknown>;
      console.log(
        `[RJ-03] 已派工方案 replan：HTTP=${replanned.status} 新方案=`
        + `${replanned.status < 400 ? (replanned.body as SchedulingPlanV2).planId : '-'}`
        + `；旧方案 plan ${String(b.plan_status)}→${String(a.plan_status)}，`
        + `dispatched assignment ${Number(b.live_assignments)}→${Number(a.live_assignments)}，`
        + `execution ${Number(b.executions)}→${Number(a.executions)}，`
        + `未释放预占 ${Number(b.active_reservations)}→${Number(a.active_reservations)}`,
      );

      // 现状实测：replan 对已派工方案同样放行，方案投影被改写，而执行侧事实原样保留。
      expect(replanned.status).toBe(201);
      expect(String(a.plan_status)).toBe('superseded');
      expect(Number(a.live_assignments)).toBe(Number(b.live_assignments));
      expect(Number(a.executions)).toBe(Number(b.executions));
      expect(Number(a.active_reservations)).toBe(Number(b.active_reservations));
    }, 120_000);
  },
);
