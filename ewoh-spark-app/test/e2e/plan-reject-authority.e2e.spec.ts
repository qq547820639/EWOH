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
import { readFileSync } from 'fs';
import { resolve } from 'path';
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

    /**
     * 归属：**CSTR-01**（《链级行为基线》§5.4 那行的"闸真长出来"读数，V355 建）。
     * 两支合起来回答一个此前只有源码读数的问：客户端经 `POST /api/scheduler/plans/:id/replan`
     * 送进来的约束，到底**改变不改变方案**。
     *
     *  ① 对照臂（必须开火）用注册表内、heuristic 本地 switch **有 case** 的 `LOCKED_DEVICE`
     *     ⇒ 新方案的设备必须被换成指定那台。这一支红了就说明"请求→求解→落库"这条通道本身带得动
     *     约束；它绿着，下面那支的"没变化"才是证据而不是恒真（V355 之前的读数全部来自走读，
     *     从未有实测把这两件事分开钉过）。
     *  ② 现状臂用注册表内、但三个消费面（编译层 6／heuristic 9／CP-SAT 6）**都没有 case** 的
     *     `RESOURCE_TIME_WINDOW`，窗口给成**过去三小时到过去两小时**——若真被执行，任务应排不进
     *     或至少报一条 violation。实测三件事一次测齐：写得进（HTTP 201）＋落得了库
     *     （`ewoh_scheduling_constraint` 有行）＋送得到求解（方案 `constraints_json` 快照里有它），
     *     而任务照排、`violations_json` 里连 `unsupported_constraint` 都没有。
     *
     * **修法落地时必须翻转第②支**（把 HARD_META 接到求解＝任务应当排不进；或把词表缩到三面之并＝
     * 这条约束应在写入侧就被判 unsupported）。不翻转就让它红在这里——那正是登记行要的"知道闸长出来了"。
     */
    it('CSTR-01 对照臂：replan 带 LOCKED_DEVICE 会真把设备换成指定那台（请求通道带得动约束）', async () => {
      // 每支自带一份新资源：前面 RJ-01/02/03 已经把夹具里那唯一一条任务消费掉了，
      // 再开 run 会拿到空 plans（V355 实测：HTTP 201 但 plans=[] ⇒ 前置被消费，不是产品回归）。
      const own = await seedSchedulerFixture(owner, fixture.orgA.id);
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
            entityId: own.taskId,
          }),
        },
      );
      if (run.status !== 201) throw new Error('run 未 201：HTTP=' + run.status + ' body=' + JSON.stringify(run.body).slice(0, 320));
      expect(run.status).toBe(201);
      expect(run.body.plans?.length ?? 0).toBeGreaterThan(0);
      const basePlanId = String(run.body.plans[0].planId);

      const before = await owner`
        SELECT task_id, device_id, person_id FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${basePlanId} AND status <> 'cancelled'`;
      expect(before.length).toBeGreaterThan(0);
      const b0 = before[0] as Record<string, unknown>;
      const currentDevice = String(b0.device_id ?? '');
      // 目标设备取本支自己夹具里的另一台（V355 实测踩过：拿上一支的 deviceIds 会锁到不属于该任务的设备，
      // 结果新方案 0 条 assignment，看着像"通道失效"，其实是夹具错配）。
      const other = own.deviceIds.map(String).find((d) => d !== currentDevice);
      // 前提：夹具的两台设备里必须真有一台"不是当前那台"，否则对照臂无从谈起。
      expect(other).toBeTruthy();

      const replanned = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${basePlanId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            reason: 'e2e CSTR-01 对照臂：锁定到另一台设备',
            lockedConstraints: [
              { type: 'LOCKED_DEVICE', taskId: String(b0.task_id), deviceId: other },
            ],
          }),
        },
      );
      expect(replanned.status).toBe(201);
      const newPlanId = String((replanned.body as SchedulingPlanV2).planId);
      expect(newPlanId).not.toBe(basePlanId);

      const after = await owner`
        SELECT task_id, device_id FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${newPlanId} AND status <> 'cancelled'`;
      expect(after.length).toBeGreaterThan(0);
      const got = new Set(after.map((r: Record<string, unknown>) => String(r.device_id)));
      console.log(
        `[CSTR-01 对照臂] LOCKED_DEVICE→${String(other)} 原设备=${currentDevice} `
        + `新方案设备集=[${[...got].join(',')}]`,
      );
      // 有牙的一支：这条通道确实带得动约束。
      expect(got.has(String(other))).toBe(true);
    }, 120_000);

    it('CSTR-01 现状臂：RESOURCE_TIME_WINDOW 写得进、落得了库、送得到求解，却不改变方案也不上报', async () => {
      // 每支自带一份新资源：前面 RJ-01/02/03 已经把夹具里那唯一一条任务消费掉了，
      // 再开 run 会拿到空 plans（V355 实测：HTTP 201 但 plans=[] ⇒ 前置被消费，不是产品回归）。
      const own = await seedSchedulerFixture(owner, fixture.orgA.id);
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
            entityId: own.taskId,
          }),
        },
      );
      if (run.status !== 201) throw new Error('run 未 201：HTTP=' + run.status + ' body=' + JSON.stringify(run.body).slice(0, 320));
      expect(run.status).toBe(201);
      expect(run.body.plans?.length ?? 0).toBeGreaterThan(0);
      const basePlanId = String(run.body.plans[0].planId);
      const before = await owner`
        SELECT task_id, person_id, device_id FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${basePlanId} AND status <> 'cancelled'`;
      expect(before.length).toBeGreaterThan(0);
      const b0 = before[0] as Record<string, unknown>;

      // 窗口整个在过去：若这五类真被执行，这条任务应当排不进去（或至少报 unsupported）。
      const now = Date.now();
      const pastStart = now - 3 * 3_600_000;
      const pastEnd = now - 2 * 3_600_000;

      const replanned = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${basePlanId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            reason: 'e2e CSTR-01 现状臂：给一条不可能满足的时间窗约束',
            lockedConstraints: [
              {
                type: 'RESOURCE_TIME_WINDOW',
                taskId: String(b0.task_id),
                personId: String(b0.person_id ?? ''),
                startMs: pastStart,
                endMs: pastEnd,
              },
            ],
          }),
        },
      );
      // ① 写得进：写入侧不校验取值域，这条约束被原样接受（V354 只有源码读数，此处补成实测）。
      expect(replanned.status).toBe(201);
      const newPlanId = String((replanned.body as SchedulingPlanV2).planId);

      const facts = await owner`
        SELECT
          (SELECT count(*)::int FROM ewoh_scheduling_constraint c
             WHERE c.org_id::text = ${org} AND c.plan_id = ${newPlanId}
               AND c.type = 'RESOURCE_TIME_WINDOW') AS constraint_rows,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment a
             WHERE a.org_id::text = ${org} AND a.plan_id = ${newPlanId}
               AND a.status <> 'cancelled'
               AND a.person_id IS NOT NULL AND a.device_id IS NOT NULL) AS live_assigned,
          (SELECT p.constraints_json::text FROM ewoh_schedule_plan p
             WHERE p.org_id::text = ${org} AND p.plan_id = ${newPlanId}) AS constraints_json,
          (SELECT p.violations_json::text FROM ewoh_schedule_plan p
             WHERE p.org_id::text = ${org} AND p.plan_id = ${newPlanId}) AS violations_json`;
      const f = facts[0] as Record<string, unknown>;
      const cjson = String(f.constraints_json ?? '');
      const vjson = String(f.violations_json ?? '');

      console.log(
        `[CSTR-01 现状臂] 约束行数=${Number(f.constraint_rows)} 仍被指派的行=${Number(f.live_assigned)} `
        + `快照含该类型=${cjson.includes('RESOURCE_TIME_WINDOW')} `
        + `违规含 unsupported=${/unsupported/i.test(vjson)}`,
      );

      // ② 落得了库。
      expect(Number(f.constraint_rows)).toBeGreaterThan(0);
      // ③ 送得到求解（方案的约束快照里有它，不是写入即弃）。
      expect(cjson.includes('RESOURCE_TIME_WINDOW')).toBe(true);
      // ④ 不改变方案：这条任务在重排前后拿到的是**同一个人＋同一台设备**——不可能窗口无人读。
      const afterRows = await owner`
        SELECT task_id, person_id, device_id FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${newPlanId} AND status <> 'cancelled'
         ORDER BY task_id`;
      // ④ 不改变方案的判据不能是"逐字相同"：重排会整批重算，设备本身就会漂（V355 实测：
      // 人没变、设备从 A 换到 B）。真正能分辨"窗口有没有被读"的是**排出来的时刻落不落在窗口里**——
      // 这条约束声明的窗口是整个在过去三小时到过去两小时，若被 honoring，这条任务不可能排到未来。
      const target = await owner`
        SELECT person_id, device_id, planned_start, planned_end
          FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${newPlanId}
           AND task_id = ${own.taskId} AND status <> 'cancelled'`;
      const expectBase = await owner`
        SELECT count(*)::int AS n FROM ewoh_scheduling_plan_assignment a
         WHERE a.org_id::text = ${org} AND a.plan_id = ${basePlanId} AND a.task_id = ${own.taskId}
           AND a.status <> 'cancelled'`;
      const t0 = target[0] as Record<string, unknown> | undefined;
      const psMs = t0 ? new Date(String(t0.planned_start)).getTime() : 0;
      console.log(
        `[CSTR-01 现状臂] 目标任务重排前是否存在指派行=${Number((expectBase[0] as Record<string, unknown>).n)} `
        + `重排后=${t0 ? '有指派' : '无指派'} planned_start=${t0 ? String(t0.planned_start) : '-'} `
        + `声明窗口=[${new Date(pastStart).toISOString()}, ${new Date(pastEnd).toISOString()}] `
        + `落点在窗口之后=${psMs > pastEnd}`,
      );
      // 前提：这条任务在挂约束之前确实被排进去了。
      expect(Number((expectBase[0] as Record<string, unknown>).n)).toBeGreaterThan(0);
      // ④a 不可能窗口没让它落空——照排。
      expect(t0).toBeTruthy();
      // ④b 排出来的时刻**晚于**窗口右端 ⇒ 窗口参数被无视（若被 honoring，这一支必然红）。
      expect(psMs > pastEnd).toBe(true);
      // ⑤ 也不上报：它在注册表内 ⇒ checkConstraintSupported 判 supported ⇒ 连 violation 都不记。
      expect(/unsupported/i.test(vjson)).toBe(false);
    }, 120_000);

    /**
     * 归属：**CSTR-01** 的非恒真对照（V355 建）。
     * 上面第④b 支比的是「排出来的时刻 > 窗口右端」。如果这条比较式在任何窗口下都成立，
     * 那它就是在报"任务排在未来"这件与约束无关的事——恒真判据不能当证据。
     * 这一支把同一个比较式喂一个**窗口右端排在计划时刻之后**的约束：若求解器真读窗口，
     * 这条任务要么落空、要么被推到窗口内；而实测它是"照常排在窗口之前"⇒ 比较式翻 false。
     * 期望值在这里是 **false**：本支存在的意义就是证明第④b 支会随窗口取值而翻转。
     */
    it('CSTR-01 反向对照：把窗口挪到计划时刻之后，同一比较式必须翻 false（证明④b 不是恒真）', async () => {
      const org = fixture.orgA.id;
      const own = await seedSchedulerFixture(owner, fixture.orgA.id);
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: own.taskId }),
        },
      );
      expect(run.status).toBe(201);
      const basePlanId = String(run.body.plans[0].planId);
      const baseRow = await owner`
        SELECT task_id, person_id, planned_start FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${basePlanId} AND task_id = ${own.taskId}
           AND status <> 'cancelled'`;
      expect(baseRow.length).toBeGreaterThan(0);
      const r0 = baseRow[0] as Record<string, unknown>;
      const plannedMs = new Date(String(r0.planned_start)).getTime();

      // 窗口整个排在计划时刻**之后**两小时起：honoring 的话任务不可能还落在现在这个位置。
      const futureStart = plannedMs + 2 * 3_600_000;
      const futureEnd = plannedMs + 3 * 3_600_000;
      const replanned = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${basePlanId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            reason: 'e2e CSTR-01 反向对照：窗口挪到计划时刻之后',
            lockedConstraints: [
              {
                type: 'RESOURCE_TIME_WINDOW',
                taskId: String(r0.task_id),
                personId: String(r0.person_id ?? ''),
                startMs: futureStart,
                endMs: futureEnd,
              },
            ],
          }),
        },
      );
      expect(replanned.status).toBe(201);
      const newPlanId = String((replanned.body as SchedulingPlanV2).planId);
      const target = await owner`
        SELECT planned_start FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${newPlanId} AND task_id = ${own.taskId}
           AND status <> 'cancelled'`;
      const t0 = target[0] as Record<string, unknown> | undefined;
      const psMs = t0 ? new Date(String(t0.planned_start)).getTime() : 0;
      console.log(
        `[CSTR-01 反向对照] planned_start=${t0 ? String(t0.planned_start) : '-'} `
        + `窗口=[${new Date(futureStart).toISOString()}, ${new Date(futureEnd).toISOString()}] `
        + `同一比较式(排出来晚于窗口右端)=${psMs > futureEnd}（期望 false）`,
      );
      expect(t0).toBeTruthy();
      // 与第④b 支**同形而值相反**：这条读到 false 才说明那条的 true 是窗口带出来的，不是恒真。
      expect(psMs > futureEnd).toBe(false);
    }, 120_000);

    /**
     * 归属：**VALDR-01**（V365 建位点、V366 落地并反转极性，出处《基线》§5.3nm／§5.3nn）。差分臂——
     * 同一个后端、同一份世界，只换"这条约束从哪来"：
     *  - A 遍在**请求里**带 `MIN_BATTERY value=101` ⇒ 求解读得到；
     *  - B 遍不带任何请求约束，只能靠 `loadForPlan` 从库里继承 A 遍落下的那一行。
     * V366 之前 B 遍会无声退回默认阈值（落库那行没有 `value` 键）；现在两遍必须给出**同一个**结果，
     * 且都低于基线 ⇒ 这一支同时钉住"写侧写得出"和"读侧读得回"，任何一侧被摘掉都会红。
     * 判据落在**设备腿个数**而不是派工总数：先试过 `MAX_WORKLOAD value=0`，在演示世界上派工 15→0，
     * 但在本夹具世界上 4→4 不动（负载门槛在首次指派前没有累计量可比）⇒ 那把尺在这里没有鉴别力。
     * 电量门槛是直接过滤候选设备的（`heuristic-scheduling-solver.ts:1715` 的 `d.batteryPct >= minBatteryPct`，
     * 而 `:395` 是 `effectiveMinBattery = minBatteryOverride ?? config.minBatteryPct`）⇒ 101% 必然清空设备腿。
     */
    it('VALDR-01 差分臂：MIN_BATTERY 的 value 请求内带得动，从库里继承回来同样生效', async () => {
      const org = fixture.orgA.id;
      const own = await seedSchedulerFixture(owner, fixture.orgA.id);
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: own.taskId }),
        },
      );
      expect(run.status).toBe(201);
      const basePlanId = String(run.body.plans[0].planId);
      const legsOf = async (planId: string) => {
        const rows = await owner`
          SELECT task_id, device_id FROM ewoh_scheduling_plan_assignment
           WHERE org_id::text = ${org} AND plan_id = ${planId} AND status <> 'cancelled'`;
        const devices = new Set(
          rows
            .map((r: Record<string, unknown>) => String(r.device_id ?? ''))
            .filter((s: string) => s !== ''),
        );
        return { n: rows.length, devices };
      };
      const base = await legsOf(basePlanId);
      // 前提：基线既有派工也有设备腿——没有设备腿的世界测不了电量门槛（本支的鉴别力就来自这里）。
      expect(base.n).toBeGreaterThan(0);
      expect(base.devices.size).toBeGreaterThan(0);

      const A = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${basePlanId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            reason: 'e2e VALDR-01 A 遍：请求内带 MIN_BATTERY value=101',
            lockedConstraints: [{ type: 'MIN_BATTERY', taskId: own.taskId, value: 101 }],
          }),
        },
      );
      expect(A.status).toBe(201);
      const planA = String((A.body as SchedulingPlanV2).planId);
      const legsA = await legsOf(planA);
      // 对照方向：门槛 101% 把有限电量的设备全排除 ⇒ 设备腿必然少于基线（请求内这一通道带得动数值参数）。
      expect(legsA.devices.size).toBeLessThan(base.devices.size);

      const persisted = await owner`
        SELECT constraint_id, type, value_json FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND plan_id = ${planA} AND type = 'MIN_BATTERY' AND active`;
      expect(persisted.length).toBeGreaterThan(0);
      const vj = (persisted[0] as Record<string, unknown>).value_json as Record<string, unknown>;
      // 写侧配套后：落库那行必须带 value，且数值原样存得住（不是字符串、不是 null）。
      expect(Object.prototype.hasOwnProperty.call(vj, 'value')).toBe(true);
      expect(vj.value).toBe(101);

      const B = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${planA}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            reason: 'e2e VALDR-01 B 遍：不带请求约束，只靠库里继承',
            lockedConstraints: [],
          }),
        },
      );
      expect(B.status).toBe(201);
      const legsB = await legsOf(String((B.body as SchedulingPlanV2).planId));
      console.log(
        `[VALDR-01 差分臂] 基线派工=${base.n} 设备腿=${base.devices.size}；`
        + `A 遍（value=101）派工=${legsA.n} 设备腿=${legsA.devices.size}；`
        + `继承行=${persisted.length} 落库 value_json=[${Object.keys(vj).join(',')}]；`
        + `B 遍（继承）派工=${legsB.n} 设备腿=${legsB.devices.size}`,
      );
      // 应然方向：同一条约束、同一份世界，从库里继承回来必须与请求内带到时给出**同一个门槛**。
      // 断"B 等于 A 且低于基线"而不写死 0：前者不依赖夹具里设备的具体电量，也不把无关漂移读成红。
      expect(legsB.devices.size).toBe(legsA.devices.size);
      expect(legsB.devices.size).toBeLessThan(base.devices.size);
      // 本例自己收：全局加载器只按 org+active+有效期筛、**不按 plan_id 筛**
      // （constraint-loader.service.ts:39 loadGlobalActive 的谓词），所以这条 value=101
      // 会以"org 级门槛"的身份渗进同一 org 后续任何一次 run（V367 实测：同文件内先跑本例、
      // 再跑 SKW-01 正向对照时，那一次基线 run 的派工行从 1 变 0——所有设备都不过门槛）。
      // 夹具级清盘在 afterAll，救不了同文件内的后序用例 ⇒ 谁写门槛谁自己摘。
      const removed = await owner`
        DELETE FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND type = 'MIN_BATTERY'
           AND plan_id IN (${planA}, ${String((B.body as SchedulingPlanV2).planId)})
        RETURNING constraint_id`;
      const still = await owner`
        SELECT 1 AS ok FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND type = 'MIN_BATTERY'`;
      console.log(
        `[VALDR-01 差分臂·自清] 摘掉本例写的门槛行=${removed.length}；`
        + `org 内剩余 MIN_BATTERY 行=${still.length}`,
      );
      expect(still.length).toBe(0);
    }, 120_000);

    /**
     * 归属：**VALDR-01**（V365 建位点、V366 反转极性）。写侧名册臂——把"两处落库入口都写 `value`、
     * 解码面也读它"钉成文本面事实：这一支与上面差分臂各钉一侧（写侧名册／读侧名册），
     * 任何一侧被摘掉都会红。V365 那一版断的是**现状**（三处都不含 `value`），落地那一轮一起翻成应然。
     */
    it('VALDR-01 写侧名册臂：两个落库入口的 valueJson 字面量都写 value，解码器也读它', async () => {
      const writers = [
        resolve(__dirname, '../../server/modules/scheduler/plan.service.ts'),
        resolve(__dirname, '../../server/modules/scheduler/scheduler-plan-application.service.ts'),
      ];
      const blocks: string[] = [];
      for (const f of writers) {
        const src = readFileSync(f, 'utf8');
        const m = src.match(/valueJson:\s*\{[^}]*\}/g) ?? [];
        // 前提：每个入口都得有一个 valueJson 字面量（读不到就说明入口被改了，这一支该红）。
        expect(m.length).toBeGreaterThan(0);
        blocks.push(...m);
      }
      const loaderSrc = readFileSync(
        resolve(__dirname, '../../server/modules/scheduler/constraint-loader.service.ts'),
        'utf8',
      );
      // 切片按结构边界收（到下一个方法的注释头为止），否则"函数后面随便一处提到 v.value"
      // 就能把这条正向断言喂绿。
      const from = loaderSrc.indexOf('private rowToConstraint');
      const to = loaderSrc.indexOf('\n  /** 稳定序列化', from);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      const decodeBody = loaderSrc.slice(from, to);
      const withValue = blocks.filter((b) => /\bvalue:/.test(b));
      console.log(
        `[VALDR-01 写侧名册臂] 写入口 valueJson 块=${blocks.length} 个，其中含 value 键=${withValue.length} 个；`
        + `解码器在 rowToConstraint 体内读 v.value=${/\bv\.value\b/.test(decodeBody)}`,
      );
      // 每个落库入口都得写（缺一处就有"从那个入口进来的数值覆盖继续静默失效"）。
      expect(withValue.length).toBe(blocks.length);
      expect(blocks.length).toBeGreaterThanOrEqual(writers.length);
      expect(/\bv\.value\b/.test(decodeBody)).toBe(true);
    }, 120_000);

    /**
     * 归属：**SKW-01**（V363 立行，V367 闭合）。种子约束行的名册臂——四行演示约束此前写的是
     * snake_case 键（`person_id`/`device_id`/`min_battery`/`start`/`end`），唯一解码器只认 camelCase
     * ⇒ 全解成 undefined，既不生效也不记 violation。这一支不手抄名册：解码器认哪些键，
     * 由 `rowToConstraint` 函数体现抽（`v.<key> as` 的全部键名），再要求每一行的键都落在名册内、
     * 且该类型求解必需的字段真的解得出值、`task_id` 指得到 `ewoh_production_task` 的主键。
     * 行数当下限断言（"零行所以全绿"不算通过）。V367 之前这一支是红的。
     */
    it('SKW-01 种子约束行：键形与值域都落在解码器名册内，锁不再在求解那一刻无声消失', async () => {
      const loaderSrc = readFileSync(
        resolve(__dirname, '../../server/modules/scheduler/constraint-loader.service.ts'),
        'utf8',
      );
      const from = loaderSrc.indexOf('private rowToConstraint');
      const to = loaderSrc.indexOf('\n  /** 稳定序列化', from);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      const roster = new Set(
        [...loaderSrc.slice(from, to).matchAll(/\bv\.([A-Za-z][A-Za-z0-9]*)\s+as\b/g)].map((m) => m[1]),
      );
      expect(roster.size).toBeGreaterThanOrEqual(10);

      const rows = await owner`
        SELECT constraint_id, type, task_id, value_json
          FROM ewoh_scheduling_constraint
         WHERE constraint_id LIKE 'CONST-%'
         ORDER BY constraint_id`;
      // 下限：种子里这三类约束各一行（V367 起 …-003 那条 per-device 已并入全局一行）
      expect(rows.length).toBeGreaterThanOrEqual(3);

      const bad: string[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        const id = String(r.constraint_id);
        const v = (r.value_json ?? {}) as Record<string, unknown>;
        const offRoster = Object.keys(v).filter((k) => !roster.has(k));
        if (offRoster.length > 0) bad.push(`${id} 键形不在解码器名册内 [${offRoster.join(',')}]`);
        if (r.task_id) {
          const hit = await owner`SELECT 1 AS ok FROM ewoh_production_task WHERE id::text = ${String(r.task_id)} LIMIT 1`;
          if (hit.length === 0) bad.push(`${id} task_id=${r.task_id} 指不到生产任务主键`);
        }
        if (r.type === 'LOCKED_PERSON') {
          const pid = typeof v.personId === 'string' ? v.personId : '';
          const hit = pid
            ? await owner`SELECT 1 AS ok FROM ewoh_personnel WHERE id::text = ${pid} LIMIT 1`
            : [];
          if (hit.length === 0) bad.push(`${id} personId 解不出值或指不到人员档案主键`);
        }
        if (r.type === 'LOCKED_TIME' && (typeof v.startMs !== 'number' || typeof v.endMs !== 'number')) {
          bad.push(`${id} 窗口不是数值毫秒（字符串窗口比较不了，等于没有窗口）`);
        }
        if (r.type === 'MIN_BATTERY' && typeof v.value !== 'number') {
          bad.push(`${id} value 不是数值 ⇒ 门槛退回策略默认`);
        }
      }
      console.log(
        `[SKW-01 种子行名册臂] 解码器名册 ${roster.size} 键；种子约束 ${rows.length} 行；不合格 ${bad.length} 行`
        + (bad.length ? ` [${bad.join(' | ')}]` : ''),
      );
      expect(bad).toEqual([]);
    }, 120_000);

    /**
     * 归属：**SKW-01**（V367 建）。正向对照——把一条锁**只写进库里**（不经请求），
     * 下一次重排必须认它。V364 量出"链级没有任何覆盖面"：七场景不派种子那批任务
     * （近 20 分钟派工 54 行里 `device_id` 非空 0 行、被锁任务一次都没进过派工），
     * 所以"注入修正形状后读数一字不差"是**没有覆盖面**而不是没有影响 ⇒ 这一支把覆盖面补出来。
     * 故意锁定一个"快照里不存在的人员"：锁定人员不在候选集 ⇒ 该任务如实不派工，
     * 于是"继承的锁到底进没进求解"有一个二元可观察量（该任务的派工从有到无）。
     */
    it('SKW-01 正向对照：只写进库里的 LOCKED_PERSON 会改变重排结果（继承的锁真的进了求解）', async () => {
      const org = fixture.orgA.id;
      const own = await seedSchedulerFixture(owner, fixture.orgA.id);
      /**
       * 前提（V367 实测定位）：起跑前本 org 不得留有 active 的**全局数值门槛**（MIN_BATTERY／MAX_WORKLOAD）。
       * 这两类解码后在求解器里是 org 级覆盖（heuristic-scheduling-solver.ts 的
       * `minBatteryOverride ?? config.minBatteryPct`），而全局加载器 `loadGlobalActive`
       * （constraint-loader.service.ts:39）只按 org+active+有效期筛、**不按 plan_id 筛** ⇒ 前序用例
       * 写在某一个方案上的门槛会渗进本例的基线 run：VALDR-01 那条 value=101 未自清时，本例
       * 基线派工行从 1 变 0，"锁定的人不在候选集 ⇒ 不派工"这条可观察量就失去对照面。
       * 其余类型带 task_id、别的用例的行碰不到本例新种的任务，故不进这条前提。
       */
      const leaky = await owner`
        SELECT constraint_id, type, plan_id FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND active
           AND type IN ('MIN_BATTERY', 'MAX_WORKLOAD')
           AND (expires_at_ms IS NULL OR expires_at_ms >= ${Date.now()})`;
      if (leaky.length > 0) {
        console.log(
          `[SKW-01 正向对照·前提塌陷] 起跑前本 org 残留全局门槛行=${JSON.stringify(leaky)}`,
        );
      }
      expect(leaky.length).toBe(0);
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: own.taskId }),
        },
      );
      expect(run.status).toBe(201);
      const basePlanId = String(run.body.plans[0].planId);
      const countTask = async (planId: string, taskId: string) => {
        const rows = await owner`
          SELECT task_id FROM ewoh_scheduling_plan_assignment
           WHERE org_id::text = ${org} AND plan_id = ${planId} AND status <> 'cancelled'`;
        return rows.filter((r: Record<string, unknown>) => String(r.task_id) === taskId).length;
      };
      // 前提：拿"基线里真被派出去的那个任务"当锁定对象——V367 第一版在这里写死了 own.taskId，
      // 结果基线派工就是 0，正向对照退化成恒真（期望 >0 当场打回）。
      const baseRows = await owner`
        SELECT task_id FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${basePlanId}
           AND status <> 'cancelled' AND task_id IS NOT NULL`;
      if (baseRows.length === 0) {
        console.log(
          `[SKW-01 正向对照·前提塌陷] 基线方案=${basePlanId} 零派工（锁定对象无从选取）`,
        );
      }
      expect(baseRows.length).toBeGreaterThan(0);
      const lockTask = String((baseRows[0] as Record<string, unknown>).task_id);
      const beforeCount = await countTask(basePlanId, lockTask);
      expect(beforeCount).toBeGreaterThan(0);

      const ghost = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
      const posCid = 'SKW01-POS-' + Date.now();
      // 写侧形状要与生产同形（`${owner.json(obj)}`，V277 定案的写法；反例说明见
      // test/e2e/concurrency-real-pg.e2e.spec.ts:212）：写成 `${JSON.stringify(vj)}::jsonb`
      // 时 postgres.js 3.4.9 会把这串"长得像 JSON 的字符串"再编码一次，落库成**字符串标量**
      // （V367 实测：jsonb_typeof=string、->> 'personId' 读成 null），于是这一行在库里的形状
      // 不是解码器读的那个形状 ⇒ 正向对照退化成"锁没进求解也照样绿"的假阳性。
      const ghostLockValueJson = {
        personId: ghost, operator: 'e2e', reason: 'SKW-01 正向对照：只写进库里的锁',
      };
      await owner`
        INSERT INTO ewoh_scheduling_constraint
          (constraint_id, org_id, plan_id, task_id, type, value_json, active, created_by)
        VALUES
          (${posCid}, ${org}, ${basePlanId}, ${lockTask}, 'LOCKED_PERSON',
           ${owner.json(ghostLockValueJson)},
           true, 'e2e')`;

      const B = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${basePlanId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ reason: 'SKW-01 正向对照 B 遍：不带请求约束，只靠库里那一行', lockedConstraints: [] }),
        },
      );
      expect(B.status).toBe(201);
      const afterLock = await countTask(String((B.body as SchedulingPlanV2).planId), lockTask);

      // 按 constraint_id 点名读回（不靠 JSON 谓词找自己的行），同时把"库里那一行的形状"读出来：
      // personId 要能用解码器那套 `value_json ->> 'personId'` 取到，才算种下了一个可解的锁。
      const mine = await owner`
        SELECT constraint_id, plan_id, active, task_id, jsonb_typeof(value_json) AS v_kind,
               value_json ->> 'personId' AS person_id
        FROM ewoh_scheduling_constraint WHERE constraint_id = ${posCid}`;
      console.log(
        `[SKW-01 正向对照] 锁定任务=${lockTask} 基线派工=${beforeCount}；`
        + `库里那一行=${mine.length} 条(value_json 形态=${mine[0]?.v_kind}/personId 可读=${mine[0]?.person_id === ghost})；`
        + `只继承库里那一行时该任务派工=${afterLock}`,
      );
      // 清掉自己种的行（按 constraint_id 点名删，别按"最新一行"删）
      await owner`DELETE FROM ewoh_scheduling_constraint WHERE constraint_id = ${posCid}`;
      const left = await owner`
        SELECT 1 AS ok FROM ewoh_scheduling_constraint WHERE constraint_id = ${posCid}`;
      expect(left.length).toBe(0);
      // 行确实在库里、且是解码器读得到的对象形状
      expect(mine.length).toBe(1);
      expect(mine[0].v_kind).toBe('object');
      expect(mine[0].person_id).toBe(ghost);
      expect(mine[0].active).toBe(true);
      expect(String(mine[0].plan_id)).toBe(basePlanId);
      // 锁进了求解 ⇒ 该任务不再被派给任何人（锁定的人不在候选集里，如实不派工）
      expect(afterLock).toBe(0);
    }, 120_000);

    /**
     * 归属：**EXPFL-01**（V367 量出、V368 落地）。真库档的有效期过滤对账。
     * 三件事一次钉住：
     *  ① 写侧配套——请求里声明的 `expiresAt` 现在同时写进 bigint 列 `expires_at_ms`
     *    （`standalone_023` 的列注释明写它是「求解前过滤依据」，V368 之前两个写入口都不写那一列）；
     *  ② 未到期 ⇒ 下一次重排继承回来照旧生效（不许把"会过滤"实现成"一律丢"）；
     *  ③ 到期 ⇒ 下一次重排不再认这条锁，该任务的派工恢复。
     * 第 ③ 步只改**列**、value_json 里的 expiresAt 留在未来时刻：解码面读 JSON 优先
     * （`v.expiresAt ?? row.expiresAtMs`），所以派工恢复这一格同时证明过滤器认的是列而不是 JSON。
     * 为什么这一族只能在真库上验：假 DB 替身的 `.where()` 是空操作
     * （`dispatch-test-harness.ts:52-56`），有效期谓词在单测档结构性看不见（V278/V320 同一条限度）⇒
     * 写侧那一半另有常驻单测钉（overrides.spec.ts 的 EXPFL-01），两面合起来才闭合。
     */
    it('EXPFL-01 有效期过滤对账：声明的 expiresAt 落到列、未到期继承照旧锁、把列改成过去时刻即放行（真库）', async () => {
      const org = fixture.orgA.id;
      const own = await seedSchedulerFixture(owner, fixture.orgA.id);
      const leaky = await owner`
        SELECT constraint_id, type FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND active AND type IN ('MIN_BATTERY', 'MAX_WORKLOAD')`;
      if (leaky.length > 0) {
        console.log(`[EXPFL-01·前提塌陷] 起跑前本 org 残留全局门槛行=${JSON.stringify(leaky)}`);
      }
      expect(leaky.length).toBe(0);
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: own.taskId }),
        },
      );
      expect(run.status).toBe(201);
      const basePlanId = String(run.body.plans[0].planId);
      const countTask = async (planId: string, taskId: string) => {
        const rows = await owner`
          SELECT task_id FROM ewoh_scheduling_plan_assignment
           WHERE org_id::text = ${org} AND plan_id = ${planId} AND status <> 'cancelled'`;
        return rows.filter((r: Record<string, unknown>) => String(r.task_id) === taskId).length;
      };
      const baseRows = await owner`
        SELECT task_id FROM ewoh_scheduling_plan_assignment
         WHERE org_id::text = ${org} AND plan_id = ${basePlanId}
           AND status <> 'cancelled' AND task_id IS NOT NULL`;
      expect(baseRows.length).toBeGreaterThan(0);
      const lockTask = String((baseRows[0] as Record<string, unknown>).task_id);
      const baseline = await countTask(basePlanId, lockTask);
      expect(baseline).toBeGreaterThan(0);

      const ghost = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
      const future = Date.now() + 3_600_000;
      const A = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${basePlanId}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            reason: 'EXPFL-01 A 遍：带一条一小时后才失效的锁',
            lockedConstraints: [
              { type: 'LOCKED_PERSON', taskId: lockTask, personId: ghost, expiresAt: future },
            ],
          }),
        },
      );
      expect(A.status).toBe(201);
      const planA = String((A.body as SchedulingPlanV2).planId);
      const afterA = await countTask(planA, lockTask);

      // ① 写侧那一半：列被填上了，而且与 value_json 同值；没带 validFrom ⇒ 列上留 NULL（null＝立即生效）。
      const rowA = await owner`
        SELECT constraint_id, expires_at_ms, valid_from_ms, value_json ->> 'expiresAt' AS json_expires
        FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND plan_id = ${planA} AND type = 'LOCKED_PERSON' AND active`;
      expect(rowA.length).toBe(1);
      expect(Number(rowA[0].expires_at_ms)).toBe(future);
      expect(String(rowA[0].json_expires)).toBe(String(future));
      expect(rowA[0].valid_from_ms).toBeNull();

      // ② 未到期 ⇒ 继承遍（不带请求约束）照旧把这条锁带进求解。
      const B = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${planA}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ reason: 'EXPFL-01 B 遍：未到期，应仍锁住', lockedConstraints: [] }),
        },
      );
      expect(B.status).toBe(201);
      const planB = String((B.body as SchedulingPlanV2).planId);
      const afterB = await countTask(planB, lockTask);

      // ③ 已过期 ⇒ 下一次重排不再认这条锁。不能拿 planA 再重排（B 遍已把它标成 superseded，
      //    实测 409），所以这一遍用**当轮最新的那份方案**做来源：照 B 遍那一行的同一形状写一行，
      //    只把 expires_at_ms 写成过去时刻、value_json 里的 expiresAt 留在未来时刻。
      //    ⇒ 两遍的唯一变量就是那一列；派工恢复即证明过滤器读的是列（解码面读 JSON 优先，
      //      若过滤器也读 JSON，这条行会被当成"未来才失效"而继续生效）。
      const past = Date.now() - 1_000;
      const pastCid = 'EXPFL01-PAST-' + Date.now();
      await owner`
        INSERT INTO ewoh_scheduling_constraint
          (constraint_id, org_id, plan_id, task_id, type, value_json, active, created_by,
           valid_from_ms, expires_at_ms)
        VALUES
          (${pastCid}, ${org}, ${planB}, ${lockTask}, 'LOCKED_PERSON',
           ${owner.json({ personId: ghost, operator: 'e2e', reason: 'EXPFL-01 C 遍：列上已过期', expiresAt: future })},
           true, 'e2e', NULL, ${past})`;
      const C = await apiRequest<SchedulingPlanV2>(
        handle.baseUrl,
        `/api/scheduler/plans/${planB}/replan`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ reason: 'EXPFL-01 C 遍：列上已过期，应放行', lockedConstraints: [] }),
        },
      );
      const cStatus = C.status;
      const planC = cStatus === 201 ? String((C.body as SchedulingPlanV2).planId) : planB;
      const afterC = await countTask(planC, lockTask);
      const rowAfter = await owner`
        SELECT expires_at_ms, value_json ->> 'expiresAt' AS json_expires
        FROM ewoh_scheduling_constraint WHERE constraint_id = ${pastCid}`;
      if (cStatus !== 201) {
        console.log(`[EXPFL-01·前提塌陷] C 遍 replan(planB) 非 201：${JSON.stringify((C as { body?: unknown }).body ?? null).slice(0, 160)}`);
      }

      console.log(
        `[EXPFL-01 有效期对账] 基线派工=${baseline}；A 遍（请求内带锁、列=${future}）派工=${afterA}；`
        + `B 遍（只继承、未到期）派工=${afterB}；C 遍（列改成 ${past}、JSON 里仍是 ${rowAfter[0]?.json_expires}）`
        + `状态=${cStatus}、派工=${afterC}`,
      );
      // 收尾：按 ghost 点名删掉本例写的行（value_json 是对象 ⇒ 谓词读得到）。
      await owner`
        DELETE FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND type = 'LOCKED_PERSON'
           AND value_json ->> 'personId' = ${ghost}`;
      const left = await owner`
        SELECT 1 AS ok FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND value_json ->> 'personId' = ${ghost}`;
      expect(left.length).toBe(0);

      expect(afterA).toBe(0);
      expect(afterB).toBe(0);
      expect(cStatus).toBe(201);
      // 过期即停手 ⇒ 该任务恢复派工（这条锁已被过滤，锁定的人不在候选集这件事不再适用）。
      expect(afterC).toBeGreaterThan(0);
    }, 180_000);
  },
);
