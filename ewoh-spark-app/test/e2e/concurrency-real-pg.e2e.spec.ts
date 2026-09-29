/** Real Nest + runtime PostgreSQL races. Every case owns fresh tenant/resources. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
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
  'Scheduler 并发/故障 E2E（真实 PostgreSQL）',
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
      // A closed local port makes the unavailable-worker case independent of a
      // developer's running CP-SAT service. Other cases use normal OFF activation.
      process.env.CPSAT_WORKER_URL = 'http://127.0.0.1:1';
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const auth = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(auth.status).toBe(201);
      token = auth.body.accessToken;
      const approver = await login(
        handle.baseUrl,
        fixture.approverA.username,
        fixture.approverA.password,
      );
      expect(approver.status).toBe(201);
      approverToken = approver.body.accessToken;
    });
    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
    });
    afterAll(async () => {
      if (originalWorkerUrl === undefined) delete process.env.CPSAT_WORKER_URL;
      else process.env.CPSAT_WORKER_URL = originalWorkerUrl;
      if (originalActivation === undefined)
        delete process.env.EWOH_SOLVER_ACTIVATION;
      else process.env.EWOH_SOLVER_ACTIVATION = originalActivation;
      await owner?.end();
    });

    async function createPlan(): Promise<SchedulingPlanV2> {
      const run = await apiRequest<{
        plans: SchedulingPlanV2[];
        debounced: boolean;
      }>(handle.baseUrl, '/api/scheduler/runs', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          strategy: 'scheduling_v2',
          trigger: 'MANUAL',
          entityId: resources.taskId,
        }),
      });
      expect(run).toMatchObject({ status: 201, body: { debounced: false } });
      expect(run.body.plans.length).toBeGreaterThan(0);
      const plan = run.body.plans[0];
      expect(plan.assignments).toHaveLength(1);
      expect(plan.assignments[0].taskId).toBe(resources.taskId);
      expect(plan.assignments[0].personId).toBe(resources.personId);
      expect(resources.deviceIds).toContain(plan.assignments[0].deviceId);
      return plan;
    }

    it('J1: 同一 approved plan 并发 dispatch → 单次有效下发、无重复 execution/reservation', async () => {
      const plan = await createPlan();
      const approve = await apiRequest(
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
      expect(approve.status).toBe(200);
      const responses = await Promise.all(
        [1, 2].map(() =>
          apiRequest(
            handle.baseUrl,
            `/api/scheduler/plans/${plan.planId}/dispatch`,
            {
              method: 'POST',
              headers: jsonHeaders(token),
            },
          ),
        ),
      );
      expect(responses.some((r) => r.status === 200)).toBe(true);
      for (const response of responses)
        expect([200, 409]).toContain(response.status);
      const plans =
        await owner`SELECT status FROM ewoh_schedule_plan WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${plan.planId}`;
      expect(plans).toHaveLength(1);
      expect(plans[0].status).toBe('dispatched');
      const executions =
        await owner`SELECT assignment_id, task_id FROM ewoh_scheduling_execution WHERE org_id = ${fixture.orgA.id} AND plan_id = ${plan.planId}`;
      expect(executions).toHaveLength(1);
      expect(executions[0].task_id).toBe(resources.taskId);
      const reservations =
        await owner`SELECT resource_type, resource_id, count(*)::int AS n FROM ewoh_resource_reservation WHERE org_id = ${fixture.orgA.id} AND plan_id = ${plan.planId} GROUP BY resource_type, resource_id`;
      expect(reservations.length).toBeGreaterThan(0);
      for (const r of reservations) expect(r.n).toBe(1);
    });

    it('J2: 两个 runtime 事务重叠预占 → 恰好一次成功，另一事务被 exclusion 拒绝', async () => {
      const runtime = postgres(config!.runtimeDatabaseUrl, { max: 2 });
      const start = Date.now();
      try {
        const results = await Promise.allSettled(
          [1, 2].map(() =>
            runtime.begin(async (tx) => {
              await tx`SELECT set_config('app.current_org_id', ${fixture.orgA.id}, true)`;
              await tx`INSERT INTO ewoh_resource_reservation
          (reservation_id, resource_id, resource_type, start_ms, end_ms, task_id, org_id, status)
          VALUES (${randomUUID()}, ${resources.personId}, 'person', ${start}, ${start + 60000}, ${resources.taskId}, ${fixture.orgA.id}, 'reserved')`;
            }),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        // 并发 INSERT 命中同一 exclusion 约束时，PostgreSQL 以两种等价方式裁决
        // 「恰好一个事务被拒」：赢者先提交 → 输家得 exclusion_violation（23P01）；
        // 两侧互等对方未提交元组 → 死锁检测器中止其一（40P01，事务整体回滚）。
        // 两者均为合法输家结局；唯一性不变量由下方行数断言承载。
        expect(['23P01', '40P01']).toContain(rejected[0].reason.code);
        const rows =
          await owner`SELECT reservation_id FROM ewoh_resource_reservation WHERE org_id = ${fixture.orgA.id} AND resource_id = ${resources.personId}`;
        expect(rows).toHaveLength(1);
      } finally {
        await runtime.end();
      }
    });

    it('J3: 并发 replan → 唯一 replacement、version 递增、旧方案 superseded', async () => {
      const plan = await createPlan();
      const responses = await Promise.all(
        [1, 2].map(() =>
          apiRequest<SchedulingPlanV2>(
            handle.baseUrl,
            `/api/scheduler/plans/${plan.planId}/replan`,
            {
              method: 'POST',
              headers: jsonHeaders(token),
              body: JSON.stringify({
                lockedConstraints: [],
                reason: 'E2E concurrent replan',
              }),
            },
          ),
        ),
      );
      expect(responses.some((r) => r.status === 201)).toBe(true);
      for (const response of responses)
        expect([201, 409]).toContain(response.status);
      const original =
        await owner`SELECT status, superseded_by FROM ewoh_schedule_plan WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${plan.planId}`;
      expect(original[0].status).toBe('superseded');
      expect(original[0].superseded_by).toBeTruthy();
      const replacement =
        await owner`SELECT plan_id, version FROM ewoh_schedule_plan WHERE org_id::text = ${fixture.orgA.id} AND trigger_entity_id = ${plan.planId}`;
      expect(replacement).toHaveLength(1);
      expect(replacement[0].plan_id).toBe(original[0].superseded_by);
      expect(replacement[0].version).toBe(plan.version + 1);
    });

    it('J4: CP-SAT worker 不可达 → 显式 UNAVAILABLE + fallback 原因 + 真实 assignment', async () => {
      // This tenant's legitimate canary policy selects CP-SAT; it cannot pass by
      // exercising the default heuristic-only OFF path.
      const canaryConfig = { cpSat: { activation: 'CANARY', canaryFraction: 1, orgAllowlist: [fixture.orgA.id] } };
      await owner`INSERT INTO ewoh_scheduling_policy (org_id, config_version, config_json, active, status)
      VALUES (${fixture.orgA.id}, 1, ${owner.json(canaryConfig)}, true, 'ACTIVE')`;
      /**
       * 前提自己也要证（V277）：这一支的意图是"canary 命中"，所以回读必须证明库里是 **jsonb 对象**
       * 且 `config_json->'cpSat'->>'activation'='CANARY'`。原先写的是 `${JSON.stringify(...)}::jsonb`
       * ——postgres.js 会把"长得像 JSON 的字符串参数"再编码一次，落库成 `jsonb_typeof='string'` 的标量，
       * 实现按字段读永远是 null ⇒ canary 从没被喂给实现，而本例当时照样绿（探针 tmp/v277-j4.mjs 实测）。
       */
      const seeded = await owner<{ t: string; activation: string | null }[]>`
        select jsonb_typeof(config_json) as t, (config_json -> 'cpSat' ->> 'activation') as activation
        from ewoh_scheduling_policy where org_id = ${fixture.orgA.id} and config_version = 1`;
      expect(String(seeded[0]?.t)).toBe('object');
      expect(String(seeded[0]?.activation)).toBe('CANARY');
      process.env.EWOH_SOLVER_ACTIVATION = 'CANARY';
      const plan = await createPlan();
      expect(plan.solverStatus).toBe('UNAVAILABLE');
      expect(plan.fallbackReason).toBeTruthy();
      const rows =
        await owner`SELECT solver_status, fallback_reason FROM ewoh_schedule_plan WHERE org_id::text = ${fixture.orgA.id} AND plan_id = ${plan.planId}`;
      expect(rows[0].solver_status).toBe('UNAVAILABLE');
      expect(rows[0].fallback_reason).toBe(plan.fallbackReason);
    });
  },
);
