/**
 * 试点链行为基线：调度/审批/派工三阶段的「重复」与「重启」列（真实 Nest + 真实 PostgreSQL）。
 *
 * 覆盖盘点判定这几格此前为空：
 *  - 审批/重复：仅内存假库断言过 requestId 复用，真实终态 CAS 未测；
 *  - 派工/重启、审批/重启：平台侧对整链的重启恢复零覆盖（假库无进程生命周期，脚本层从不重启后端）；
 *  - 调度/重复：触发去抖仅在假库单测里断过。
 * 本文件只观测既有行为，不改产品代码。
 */
import { randomUUID } from 'node:crypto';
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
  '链阶段重复/重启基线 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let dispatcherToken: string;
    let approverToken: string;
    const originalActivation = process.env.EWOH_SOLVER_ACTIVATION;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });

    afterAll(async () => {
      if (originalActivation === undefined) delete process.env.EWOH_SOLVER_ACTIVATION;
      else process.env.EWOH_SOLVER_ACTIVATION = originalActivation;
      await owner?.end();
    });

    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        handle = undefined as unknown as E2EAppHandle;
        if (fixture) await cleanupE2EFixture(owner, fixture);
        fixture = undefined as unknown as E2EFixture;
      }
    });

    /** 起后端并登录两个身份；重启 = 先 close 再调用本函数。 */
    async function boot(): Promise<string> {
      if (!fixture) {
        fixture = await createE2EFixture(owner);
        resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      }
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
      return handle.baseUrl;
    }

    async function createPlan(baseUrl: string): Promise<SchedulingPlanV2> {
      const run = await apiRequest<{ plans: SchedulingPlanV2[]; debounced: boolean }>(
        baseUrl,
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
      return plan;
    }

    function approvePlan(baseUrl: string, plan: SchedulingPlanV2) {
      return apiRequest(
        baseUrl,
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
    }

    function dispatchPlan(baseUrl: string, plan: SchedulingPlanV2) {
      return apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan.planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken) },
      );
    }

    async function planStatus(planId: string): Promise<string> {
      const rows = await owner`SELECT status FROM ewoh_schedule_plan
        WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${planId}`;
      expect(rows).toHaveLength(1);
      return String(rows[0].status);
    }

    it('C-01 审批重复：同一方案二次审批被拒，且不改写已批准状态与版本', async () => {
      const baseUrl = await boot();
      const plan = await createPlan(baseUrl);
      expect((await approvePlan(baseUrl, plan)).status).toBe(200);

      const second = await approvePlan(baseUrl, plan);
      expect([400, 403, 409]).toContain(second.status);
      expect(await planStatus(plan.planId)).toBe('approved');

      const assignments = await owner`SELECT status, count(*)::int AS n
        FROM ewoh_scheduling_plan_assignment
        WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${plan.planId}
        GROUP BY status`;
      expect(assignments).toHaveLength(1);
      expect(String(assignments[0].status)).toBe('approved');

      const audit = await owner`SELECT count(*)::int AS n FROM ewoh_schedule_audit
        WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${plan.planId}`;
      expect(Number(audit[0].n)).toBe(1); // 二次审批不得再落一条审批审计
    });

    it('C-02 审批与派工跨重启：批准态存活、派工只生效一次、终态不可重入', async () => {
      let baseUrl = await boot();
      const plan = await createPlan(baseUrl);
      expect((await approvePlan(baseUrl, plan)).status).toBe(200);

      // 审批完成后立刻重启：批准事实必须只存在于库里，不依赖任何内存态。
      await handle.close();
      handle = undefined as unknown as E2EAppHandle;
      baseUrl = await boot();
      expect(await planStatus(plan.planId)).toBe('approved');

      const dispatched = await dispatchPlan(baseUrl, plan);
      expect(dispatched.status).toBe(200);

      await handle.close();
      handle = undefined as unknown as E2EAppHandle;
      baseUrl = await boot();

      expect(await planStatus(plan.planId)).toBe('dispatched');
      const replay = await dispatchPlan(baseUrl, plan);
      expect(replay.status).toBe(409);

      const perAssignment = await owner`SELECT assignment_id, count(*)::int AS n
        FROM ewoh_scheduling_execution
        WHERE org_id = ${fixture.orgA.id} AND plan_id = ${plan.planId}
        GROUP BY assignment_id`;
      expect(perAssignment.length).toBeGreaterThan(0);
      for (const row of perAssignment) expect(Number(row.n)).toBe(1);
      const events = await owner`SELECT count(*)::int AS n FROM ewoh_assignment_event
        WHERE org_id::text = ${fixture.orgA.id}`;
      const executionCount = await owner`SELECT count(*)::int AS n
        FROM ewoh_scheduling_execution WHERE org_id = ${fixture.orgA.id} AND plan_id = ${plan.planId}`;
      expect(Number(events[0].n)).toBe(Number(executionCount[0].n));

      // PROJ-02（V223）：上面那句只比"事件条数＝执行行数"，看不见"权威状态改了而事件没跟上"。
      // 这里对的是**权威源本身**：每条已派工的 assignment，其当前 status 必须等于它最后一条
      // assignment_event 的 to_status（事件流与权威状态逐条对齐，而不是数量对齐）。
      const dispatchedRows = await owner`SELECT count(*)::int AS n FROM ewoh_scheduling_plan_assignment
        WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${plan.planId} AND status = 'dispatched'`;
      expect(Number(dispatchedRows[0].n)).toBeGreaterThan(0); // 否则下面的对账是恒真
      const drift = await owner`
        WITH last_event AS (
          SELECT DISTINCT ON (assignment_id) assignment_id AS lid, to_status
            FROM ewoh_assignment_event
           WHERE assignment_id IS NOT NULL AND org_id::text = ${fixture.orgA.id}
           ORDER BY assignment_id, created_at DESC, event_id DESC
        )
        SELECT a.assignment_id, a.status AS authoritative, le.to_status AS last_event_status
          FROM ewoh_scheduling_plan_assignment a
          LEFT JOIN last_event le ON le.lid = a.assignment_id::text
         WHERE a.org_id::text = ${fixture.orgA.id} AND a.plan_id = ${plan.planId}
           AND a.status = 'dispatched'
           AND le.to_status IS DISTINCT FROM 'dispatched'`;
      expect(drift).toEqual([]);
    });

    it('C-03 调度触发重复：同一实体的二次手工触发被去抖，不产生第二个 run', async () => {
      const baseUrl = await boot();
      const before = await owner`SELECT count(*)::int AS n FROM ewoh_scheduling_run
        WHERE org_id::text = ${fixture.orgA.id}`;
      const first = await apiRequest<{ debounced: boolean }>(baseUrl, '/api/scheduler/runs', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({
          strategy: 'scheduling_v2',
          trigger: 'MANUAL',
          entityId: resources.taskId,
        }),
      });
      expect(first.status).toBe(201);
      expect(first.body.debounced).toBe(false);

      const second = await apiRequest<{ debounced?: boolean }>(baseUrl, '/api/scheduler/runs', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({
          strategy: 'scheduling_v2',
          trigger: 'MANUAL',
          entityId: resources.taskId,
        }),
      });
      const after = await owner`SELECT count(*)::int AS n FROM ewoh_scheduling_run
        WHERE org_id::text = ${fixture.orgA.id}`;
      // 去抖必须体现在「少一个 run」上，而不是只体现在响应标志位。
      expect(Number(after[0].n) - Number(before[0].n)).toBe(1);
      expect([200, 201, 202, 409]).toContain(second.status);
      expect(second.body?.debounced ?? true).toBe(true);
    });
  },
);
