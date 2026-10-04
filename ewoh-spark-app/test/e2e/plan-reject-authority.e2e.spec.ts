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
     * 归属：**VALDR-01**（V365 建，出处《基线》§5.3nm）。差分臂——同一个后端、同一份世界，
     * 只换"这条约束从哪来"：
     *  - A 遍在**请求里**带 `MIN_BATTERY value=101` ⇒ 求解读得到（对照方向：这条通道带得动数值参数）；
     *  - B 遍不带任何请求约束，只能靠 `loadForPlan` 从库里继承 A 遍落下的那一行 ⇒ 门槛无声退回默认。
     * 两支期望值方向相反，所以这不是恒真的"钉现状"。判据落在**设备腿个数**而不是派工总数：
     * 先试过 `MAX_WORKLOAD value=0`，在演示世界上派工 15→0，但在本夹具世界上 4→4 不动
     * （负载门槛在首次指派前没有累计量可比）⇒ 那把尺在这里没有鉴别力。电量门槛是直接过滤候选设备的
     * （`heuristic-scheduling-solver.ts:1715` 的 `d.batteryPct >= minBatteryPct`，
     * 而 `:395` 是 `effectiveMinBattery = minBatteryOverride ?? config.minBatteryPct`）⇒ 101% 必然清空设备腿。
     */
    it('VALDR-01 差分臂：MIN_BATTERY 的 value 请求内带得动，从库里继承回来即失效', async () => {
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
      // 对照方向：门槛 101% 把有限电量的设备全排除 ⇒ 设备腿必然少于基线（求解读不到 value 这一支就先红）。
      expect(legsA.devices.size).toBeLessThan(base.devices.size);

      const persisted = await owner`
        SELECT constraint_id, type, value_json FROM ewoh_scheduling_constraint
         WHERE org_id::text = ${org} AND plan_id = ${planA} AND type = 'MIN_BATTERY' AND active`;
      expect(persisted.length).toBeGreaterThan(0);
      const vj = (persisted[0] as Record<string, unknown>).value_json as Record<string, unknown>;
      // 落库那行没有 value ⇒ 数值参数在**写侧**就被丢掉（不是读侧解析不到）。
      expect(Object.prototype.hasOwnProperty.call(vj, 'value')).toBe(false);

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
      // 缺陷方向：同一条约束、同一份世界，只因改从库里读回来，门槛就无声退回默认。
      // 断"B 多于 A"而不是"B 等于基线"：后者会把与本缺陷无关的时刻漂移也读成红。
      expect(legsB.devices.size).toBeGreaterThan(legsA.devices.size);
    }, 120_000);

    /**
     * 归属：**VALDR-01**（V365 建）。写侧名册臂——把"两处落库入口都不写 `value`"钉成文本面事实，
     * 并把解码面缺同一个键也钉住：三者一起补上时这一支会红，那就是登记行要的"知道闸长出来了"。
     * 断言的是**现状**（as-is），修法落地时必须与《基线》§5.4 的 VALDR-01 行一起翻转。
     */
    it('VALDR-01 写侧名册臂：两个落库入口的 valueJson 字面量都不写 value，解码器也不读它', async () => {
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
      const decodeBody = loaderSrc.slice(loaderSrc.indexOf('private rowToConstraint'));
      console.log(
        `[VALDR-01 写侧名册臂] 写入口 valueJson 块=${blocks.length} 个，其中含 value 键=${blocks.filter((b) => /\bvalue:/.test(b)).length} 个；`
        + `解码器读 v.value=${/\bv\.value\b/.test(decodeBody)}`,
      );
      expect(blocks.filter((b) => /\bvalue:/.test(b)).length).toBe(0);
      expect(/\bv\.value\b/.test(decodeBody)).toBe(false);
    }, 120_000);
  },
);
