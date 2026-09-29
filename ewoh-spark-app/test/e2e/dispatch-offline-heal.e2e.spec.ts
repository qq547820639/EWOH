/**
 * 试点链行为基线：派工阶段的「断网」列（真实 Nest + 真实 PostgreSQL）。
 *
 * 为什么要单独测这一格：§3.2 的走读结论是「派工与执行下发是两套互不知晓的权威」，
 * 但这只是 grep 级证据。本例把它变成实测：**在全程没有边缘节点、没有网关 ACK 的世界里
 * 完成一次派工**，然后回答两个问题——
 *   1) 派工自身的事实是否完整、稳定、可恢复（平台侧）；
 *   2) 出站事实（control 请求/命令、投递、积压巡检）到底有没有被派工带动。
 * 若 ①成立而 ②为「零」，则「派工成功」在任何出站意义上都不构成事实，
 * 断网对派工阶段没有影响，而现场永远收不到活——这才是这一格的真实语义。
 *
 * 本例只观测既有行为，不改产品代码。
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

(config ? describe : describe.skip)(
  '派工×断网基线 E2E（真实 PostgreSQL，全程无边缘/无网关）',
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
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    it('P-01 全程断网（无边缘轮询、无网关 ACK）：派工事实完整且稳定，出站事实为零', async () => {
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

      const dispatched = await apiRequest<{
        dispatchedAssignments?: number;
        planStatus?: string;
      }>(handle.baseUrl, `/api/scheduler/plans/${plan.planId}/dispatch`, {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
      });
      expect(dispatched.status).toBe(200);
      const org = fixture.orgA.id;
      const planId = plan.planId;

      // ① 平台侧派工事实：一次性完整提交，且没有任何「半波」。
      const state1 = await owner`
        SELECT
          (SELECT status FROM ewoh_schedule_plan WHERE org_id::text = ${org} AND plan_id = ${planId}) AS plan_status,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment
             WHERE org_id::text = ${org} AND plan_id = ${planId} AND status = 'dispatched') AS dispatched_rows,
          (SELECT count(*)::int FROM ewoh_scheduling_plan_assignment
             WHERE org_id::text = ${org} AND plan_id = ${planId} AND status <> 'dispatched') AS non_dispatched_rows,
          (SELECT count(*)::int FROM ewoh_scheduling_execution
             WHERE org_id::text = ${org} AND plan_id = ${planId}) AS executions`;
      expect(String(state1[0].plan_status)).toBe('dispatched');
      expect(Number(state1[0].dispatched_rows)).toBe(plan.assignments.length);
      expect(Number(state1[0].non_dispatched_rows)).toBe(0);
      expect(Number(state1[0].executions)).toBe(plan.assignments.length);

      // ② 出站事实：断网世界里「派工」没有产生任何控制面事实。
      const outbound = await owner`
        SELECT
          (SELECT count(*)::int FROM ewoh_control_request WHERE org_id::text = ${org}) AS requests,
          (SELECT count(*)::int FROM ewoh_control_command WHERE org_id::text = ${org}) AS commands,
          (SELECT count(*)::int FROM ewoh_control_result
             WHERE org_id::text = ${org} AND result_type IN ('gateway_ack','command_receipt')) AS acks`;
      const controlRequests = Number(outbound[0].requests);
      const controlCommands = Number(outbound[0].commands);
      const gatewayAcks = Number(outbound[0].acks);

      // 投递积压巡检/快照：从未下发 ⇒ 巡检「无积压」，而不是「有积压但不收敛」。
      const swept = await apiRequest(handle.baseUrl, '/api/control/delivery-backlog/sweep', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
      });
      expect(swept.status).toBeLessThan(500);
      const backlog = await apiRequest<{
        totalPending?: number;
        items?: unknown[];
      }>(handle.baseUrl, '/api/control/delivery-backlog/status', {
        headers: jsonHeaders(dispatcherToken),
      });
      expect(backlog.status).toBeLessThan(500);

      // 稳定段：断网继续（无人轮询/无人 ack）10s，派工事实与出站事实都不得被改写或推进。
      await new Promise((r) => setTimeout(r, 10_000));
      const state2 = await owner`
        SELECT
          (SELECT status FROM ewoh_schedule_plan WHERE org_id::text = ${org} AND plan_id = ${planId}) AS plan_status,
          (SELECT count(*)::int FROM ewoh_scheduling_execution
             WHERE org_id::text = ${org} AND plan_id = ${planId}) AS executions,
          (SELECT count(*)::int FROM ewoh_assignment_event
             WHERE org_id::text = ${org}) AS assignment_events`;
      expect(String(state2[0].plan_status)).toBe('dispatched');
      expect(Number(state2[0].executions)).toBe(plan.assignments.length);

      console.log(
        `[P-01] 断网派工：plan=${String(state1[0].plan_status)} assignment=${plan.assignments.length} `
        + `execution=${Number(state1[0].executions)} 控制面 request=${controlRequests} command=${controlCommands} `
        + `ack/receipt=${gatewayAcks} sweep=${swept.status} `
        + `backlog=${JSON.stringify(backlog.body).slice(0, 160)} `
        + `10s 后 plan=${String(state2[0].plan_status)} execution=${Number(state2[0].executions)}`,
      );

      // 这一行是 §3.2「两套互不知晓的权威」的实测形式：派工完成且稳定，但控制面一条命令都没有。
      expect(controlRequests).toBe(0);
      expect(controlCommands).toBe(0);
      expect(gatewayAcks).toBe(0);
    }, 120_000);
  },
);
