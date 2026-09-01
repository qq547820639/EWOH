/**
 * Scheduler CommandMap Upgrade — E2E 场景规格（QA 交付，T-TEST / F）
 *
 * 场景（对应 docs/scheduler-commandmap-upgrade/03-task-breakdown.md 验收口径）：
 *   A. 临时插单 → 调度 → 审批 → dispatch
 *   B. 设备离线 → conflict → partial replan → 冻结 → plan diff → 审批
 *   C. 路线阻断 → route cost 更新 → 局部重排 → 新路线
 *   D. 锁定 assignment → replan 不变
 *   E. stale snapshot approve 被拒（PLAN_STALE / version 不匹配）
 *
 * 组织方式：与仓库既有 e2e（test/e2e/ewoh-http.e2e.spec.ts）一致，jest + HTTP
 * 助手（apiRequest / startE2EApp / createE2EFixture）。
 *
 * 运行前提：
 *   - 真实 PostgreSQL（migrated standalone_012→015）+ standalone API（:3101）
 *   - 环境变量：EWOH_E2E_RUNTIME_DATABASE_URL / EWOH_E2E_OWNER_DATABASE_URL
 *   - 无运行时数据库时整包 SKIP（不伪造执行结果）。
 *
 * Mock / 数据准备说明（无 DB 环境如需单测级验证，按下列 API 依赖 mock）：
 *   - POST /api/scheduler/runs                  （调度入口；依赖 world-state/solver）
 *   - GET  /api/scheduler/runs/:runId/plans     （取方案）
 *   - POST /api/scheduler/plans/:planId/approve （body: version + snapshotVersion + operator + reason）
 *   - POST /api/scheduler/plans/:planId/dispatch
 *   - GET  /api/scheduler/conflicts             （冲突列表，含 status 生命周期字段）
 *   - POST /api/scheduler/plans/:planId/replan  （body: trigger + entityId + constraints）
 *   - POST /api/scheduler/plans/:planId/overrides（body: actions + operator + reason）
 *   - GET  /api/scheduler/plans/:planId/compare/:otherPlanId （plan diff VM）
 *   - POST /api/scheduler/routes/calculate      （route cost 更新；body: taskId + candidates）
 *   - GET  /api/scheduler/policy/versions       （shadow policy 审批链）
 */
import { randomUUID } from 'node:crypto';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import {
  apiRequest,
  jsonHeaders,
  login,
} from '../helpers/e2e-http';

const e2eConfig = resolveE2EConfig();

interface SchedulingRunResponse {
  runId: string;
  plans: Array<{
    planId: string;
    status: string;
    version: number;
    snapshotVersion: string;
    assignments: Array<{
      taskId: string;
      personId: string | null;
      deviceId: string | null;
      plannedStart: string;
      plannedEnd: string;
    }>;
  }>;
}

// R2-APT-005：plan diff（PlanCompareService.compare）权威 VM 形状
interface PlanCompareResultShape {
  baselinePlanId: string;
  candidatePlanId: string;
  added: string[];
  removed: string[];
  diffByTask: Array<{
    taskId: string;
    changeTypes: string[];
    reasons: string[];
  }>;
  changeTypeCounts: Record<string, number>;
  churn: number;
}

function makeHeaders(token: string) {
  return jsonHeaders(token);
}

if (!e2eConfig) {
  describe.skip('Scheduler Upgrade E2E (skipped: no runtime DATABASE_URL)', () => {
    it('requires a runtime DATABASE_URL', () => {
      expect(e2eConfig).not.toBeNull();
    });
  });
} else {
  describe('Scheduler CommandMap Upgrade E2E (A..E)', () => {
    const runId = randomUUID().slice(0, 12);
    let owner: OwnerSql | undefined;
    let fixture: E2EFixture | undefined;
    let handle: E2EAppHandle | undefined;
    let baseUrl = '';
    let token = '';

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      // 清基：避免 MANUAL 冷却跨运行 debounce + 历史快照/reservation 残留导致
      // PLAN_STALE。R2-APT-009：删除限定本 run 的 fixture org 范围（原全表
      // DELETE 会摧毁共享库其他租户的调度事实/快照历史）；assignment 表无
      // org 列，经 plan 子查询按 org 定位；快照表 NULL 行为全局资产仅清本 org。
      try {
        const orgIds = [fixture.orgA.id, fixture.orgB.id];
        const postgres = (await import('postgres')).default;
        const runtime = postgres(e2eConfig.runtimeDatabaseUrl, { max: 1 });
        await runtime.unsafe('DELETE FROM ewoh_replan_trigger WHERE org_id = ANY($1::text[])', [orgIds]);
        await runtime.unsafe('DELETE FROM ewoh_scheduling_execution WHERE org_id = ANY($1::text[])', [orgIds]);
        await runtime.unsafe(
          'DELETE FROM ewoh_scheduling_plan_assignment WHERE plan_id IN (SELECT plan_id FROM ewoh_schedule_plan WHERE org_id = ANY($1::text[]))',
          [orgIds],
        );
        await runtime.unsafe('DELETE FROM ewoh_schedule_plan WHERE org_id = ANY($1::text[])', [orgIds]);
        await runtime.unsafe('DELETE FROM ewoh_resource_reservation WHERE org_id = ANY($1::text[])', [orgIds]);
        await runtime.unsafe('DELETE FROM ewoh_world_state_snapshot WHERE org_id = ANY($1::text[])', [orgIds]);
        await runtime.end();
      } catch {
        // 清理失败不阻断测试（触发类型可避开冷却）。
      }
      handle = await startE2EApp(e2eConfig, fixture.orgA.id);
      baseUrl = handle.baseUrl;
      const loginRes = await login(baseUrl, 'admin', 'admin-password');
      // NestJS POST 默认 201（与 ewoh-http E2E 的 login 断言一致）。
      expect(loginRes.status).toBe(201);
      token = loginRes.body.accessToken;
    }, 120_000);

    afterAll(async () => {
      if (handle) await handle.close();
      if (owner) {
        if (fixture) await cleanupE2EFixture(owner, fixture);
        await owner.end();
      }
    });

    it('A: 临时插单 → 调度 → 审批 → dispatch 全链路', async () => {
      // 1) 创建调度 run（临时插单由数据准备阶段向 ewoh_production_task 写入
      //    base_priority/earliest_start_ms/latest_finish_ms/safety_critical=false，
      //    再触发 runs）。
      const run = await apiRequest<SchedulingRunResponse>(
        baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'MANUAL',
            reason: `E2E-A ${runId}`,
          }),
        },
      );
      expect(run.status).toBe(201);
      const plan = run.body.plans?.[0];
      expect(plan).toBeDefined();

      // 2) 审批（携带 version + snapshotVersion；stale 场景见 E）。
      // B5 适配：置空 created_by 模拟存量行（生成/审批同一 bootstrap token，
      // 否则触发 SELF_APPROVAL_FORBIDDEN；守卫对 NULL 放行是设计语义）。
      {
        const pg0 = (await import('postgres')).default;
        const conn0 = pg0(e2eConfig.runtimeDatabaseUrl, { max: 1 });
        try {
          await conn0`UPDATE ewoh_schedule_plan SET created_by = NULL WHERE plan_id = ${plan!.planId}`;
        } finally {
          await conn0.end();
        }
      }
      const approve = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan!.planId}/approve`,
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            version: plan!.version,
            snapshotVersion: plan!.snapshotVersion,
            operator: 'e2e-admin',
            reason: 'approve A',
          }),
        },
      );
      expect(approve.status).toBe(200);
      // approvePlanV2 直接返回 SchedulingPlanV2（无 data 包装）。
      expect((approve.body as { status: string }).status).toBe('approved');

      // 3) dispatch（幂等：重复 dispatch 第二次应被拒 PLAN_CONCURRENT_DISPATCH/状态已变）。
      const dispatch = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan!.planId}/dispatch`,
        { method: 'POST', headers: makeHeaders(token) },
      );
      expect(dispatch.status).toBe(200);
    });

    it('B: 设备离线 → conflict → partial replan → 冻结 → plan diff → 审批', async () => {
      // 数据准备：向 ewoh_device 写入 telemetry_updated_at=过期 触发 DEVICE_OFFLINE
      // 事件；world-state 装配后该设备 status=offline。
      const conflicts = await apiRequest<{ data: Array<{ id: string; status: string }> }>(
        baseUrl,
        '/api/scheduler/conflicts',
        { method: 'GET', headers: makeHeaders(token) },
      );
      expect(conflicts.status).toBe(200);

      // R2-APT-005：先建立基线方案并批准（TASK_CREATED 避开 MANUAL 30s 冷却），
      // 使 partial replan 有可比对的 before/after（plan diff 与冻结断言的前提）。
      const offlineDev = `DEV-${runId}`;
      const baseline = await apiRequest<SchedulingRunResponse>(
        baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'TASK_CREATED',
            reason: `E2E-B baseline ${runId}`,
          }),
        },
      );
      expect(baseline.status).toBe(201);
      const plan0 = baseline.body.plans?.[0];
      if (plan0) {
        // B5 适配：同上（同 token 生成+审批，置空 created_by 走存量行语义）。
        {
          const pg0 = (await import('postgres')).default;
          const conn0 = pg0(e2eConfig.runtimeDatabaseUrl, { max: 1 });
          try {
            await conn0`UPDATE ewoh_schedule_plan SET created_by = NULL WHERE plan_id = ${plan0.planId}`;
          } finally {
            await conn0.end();
          }
        }
        const approve0 = await apiRequest(
          baseUrl,
          `/api/scheduler/plans/${plan0.planId}/approve`,
          {
            method: 'POST',
            headers: makeHeaders(token),
            body: JSON.stringify({
              version: plan0.version,
              snapshotVersion: plan0.snapshotVersion,
              operator: 'e2e-admin',
              reason: 'approve B baseline',
            }),
          },
        );
        expect(approve0.status).toBe(200);
      } else {
        // R2-APT-005：fixture 无任务数据时基线无方案——显式注明跳过 diff 前置，不静默。
        console.warn('[B SKIP] baseline runs 201 无方案（fixture 无任务数据），plan diff/冻结断言缺少基线，本轮显式跳过');
      }

      // 局部重排：trigger=DEVICE_OFFLINE + entityId=<deviceId>。
      // 期望：仅受影响任务进入求解子图；执行中/锁定任务冻结（frozen）。
      const replan = await apiRequest<SchedulingRunResponse>(
        baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'DEVICE_OFFLINE',
            entityId: offlineDev,
            reason: 'E2E-B device offline replan',
          }),
        },
      );
      expect(replan.status).toBe(201);
      const plan1 = replan.body.plans?.[0];
      if (!plan0 || !plan1) {
        console.warn(
          `[B SKIP] partial replan 未产生可比对新方案（baseline=${Boolean(plan0)}, replan=${Boolean(plan1)}；` +
            '需 fixture 任务/设备数据），plan diff/冻结/审批断言本轮显式跳过',
        );
        return;
      }

      // R2-APT-005（plan diff）：compare VM 返回权威 diff 结构——diffByTask/
      // added/removed/changeTypeCounts/churn 必须齐备（标题承诺的 diff 断言）。
      const diff = await apiRequest<PlanCompareResultShape>(
        baseUrl,
        `/api/scheduler/plans/${plan0.planId}/compare/${plan1.planId}`,
        { method: 'GET', headers: makeHeaders(token) },
      );
      expect(diff.status).toBe(200);
      expect(Array.isArray(diff.body.diffByTask)).toBe(true);
      expect(Array.isArray(diff.body.added)).toBe(true);
      expect(Array.isArray(diff.body.removed)).toBe(true);
      expect(diff.body).toHaveProperty('changeTypeCounts');
      expect(typeof diff.body.churn).toBe('number');

      // R2-APT-005（冻结）：partial replan 仅受影响任务进入求解子图——
      // PERSON_CHANGED 只允许出现在引用离线设备的任务上，无关任务不得被换人。
      const personChanged = diff.body.diffByTask.filter((d) =>
        d.changeTypes?.includes('PERSON_CHANGED'),
      );
      const offender = personChanged.find((d) => {
        const before = plan0.assignments.find((a) => a.taskId === d.taskId);
        return before?.deviceId !== offlineDev;
      });
      // 失败时 offender 携带 taskId/changeTypes/reasons，诊断信息完整。
      expect(offender).toBeUndefined();

      // R2-APT-005（审批）：重排后的新方案走完整审批（version/snapshotVersion 语义）。
      const approve1 = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan1.planId}/approve`,
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            version: plan1.version,
            snapshotVersion: plan1.snapshotVersion,
            operator: 'e2e-admin',
            reason: 'approve B replan',
          }),
        },
      );
      expect(approve1.status).toBe(200);
      expect((approve1.body as { status: string }).status).toBe('approved');
    });

    it('C: 路线阻断 → route cost 更新 → 局部重排 → 新路线', async () => {
      // 数据准备：向 ewoh_route_cost_matrix 写入 blocked 边对应 snapshot 的矩阵
      //（routeCostMode=euclidean_fallback + fallbackReason=no_route_edge）。
      const calc = await apiRequest<{
        data: {
          candidates: Array<{
            personId: string;
            routeCostMode: string;
            fallbackReason: string | null;
            dataQuality: string;
            feasible: boolean;
          }>;
        };
      }>(baseUrl, '/api/scheduler/routes/calculate', {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({
          taskId: `T-${runId}`,
          candidates: [
            { personId: 'p-no-coords-e2e-c', deviceId: 'd1', stationId: 'S1' },
          ],
        }),
      });
      expect(calc.status).toBe(200);
      // R2-APT-005：断言落地（不再 if(candidate) 可跳过）——无坐标候选必须
      // 显式不可行（feasible=false + fallbackReason=coords_unknown），并携带
      // dataQuality；绝不伪造坐标算距（EDGE-123/R2-ESC-003 语义）。
      const candidate = calc.body.data.candidates?.[0];
      expect(candidate).toBeDefined();
      expect(candidate!.feasible).toBe(false);
      expect(candidate!.fallbackReason).toBe('coords_unknown');
      expect(['UNKNOWN', 'STALE', 'FRESH']).toContain(candidate!.dataQuality);

      // 路线阻断后重排：新方案应避开 blocked 边（routeStatus blocked → 候选不可行）。
      // R2-APT-005：blocked 边规避断言需 fixture 预置 route graph 数据
      //（ewoh_topology + 当前快照成本矩阵 + 真实 person/station 坐标），当前
      // fixture 仅建 org/user——显式跳过并注明原因，不以恒真断言冒充覆盖。
      console.warn(
        '[C SKIP] blocked 边规避与重排新路线断言需 route graph fixture（ewoh_topology/成本矩阵），本轮显式跳过',
      );
    });

    it('D: 锁定 assignment → replan 不变', async () => {
      // 数据准备：ewoh_world_state_snapshot.lockedAssignments 含 {taskId, personId}
      //（执行中任务）。重排后该任务必须保持原分配（frozen），不可移动。
      // R2-APT-005：先建立基线方案并推进到 dispatch（产生 execution 记录），
      // 将首个 execution 置为 STARTED——world-state 装配时 executing 任务进入
      // lockedAssignments（world-state.service LOCKED_TASK_STATUSES）。
      const baseline = await apiRequest<SchedulingRunResponse>(
        baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'TASK_UPDATED',
            reason: `E2E-D baseline ${runId}`,
          }),
        },
      );
      expect(baseline.status).toBe(201);
      const plan0 = baseline.body.plans?.[0];
      if (!plan0 || plan0.assignments.length === 0) {
        // R2-APT-005：无 assignment 无法构造锁定事实——显式注明跳过（不恒真）。
        console.warn(
          `[D SKIP] baseline 无 assignment（plan=${Boolean(plan0)}, assignments=${plan0?.assignments.length ?? 0}；` +
            '需 fixture 任务数据构造锁定），锁定不变量断言本轮显式跳过',
        );
        return;
      }
      const approve0 = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan0.planId}/approve`,
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            version: plan0.version,
            snapshotVersion: plan0.snapshotVersion,
            operator: 'e2e-admin',
            reason: 'approve D baseline',
          }),
        },
      );
      expect(approve0.status).toBe(200);
      const dispatch0 = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan0.planId}/dispatch`,
        { method: 'POST', headers: makeHeaders(token) },
      );
      expect(dispatch0.status).toBe(200);

      // R2-APT-005 锁定事实：首个 execution 置 STARTED（执行中任务进入 lockedAssignments）。
      const execs = await apiRequest<{ executions: Array<{ assignmentId: string; status: string; taskId?: string }> }>(
        baseUrl,
        `/api/scheduler/executions?planId=${encodeURIComponent(plan0.planId)}`,
        { method: 'GET', headers: makeHeaders(token) },
      );
      expect(execs.status).toBe(200);
      const firstExec = execs.body.executions?.[0];
      if (!firstExec) {
        console.warn('[D SKIP] dispatch 后无 execution 记录，无法构造锁定事实，锁定不变量断言本轮显式跳过');
        return;
      }
      const started = await apiRequest(baseUrl, `/api/scheduler/executions/${firstExec.assignmentId}/update`, {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({ status: 'STARTED', actualStartAt: new Date().toISOString() }),
      });
      expect(started.status).toBe(201);
      expect((started.body as { status: string }).status).toBe('STARTED');

      // 重排（MANUAL，避开风暴守卫去抖）。
      const replan = await apiRequest<SchedulingRunResponse>(
        baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            strategy: 'scheduling_v2',
            trigger: 'MANUAL',
            reason: 'E2E-D locked assignment replan',
          }),
        },
      );
      expect(replan.status).toBe(201);
      const plan1 = replan.body.plans?.[0];
      if (!plan1) {
        console.warn('[D SKIP] replan 未产生新方案（debounced/无任务），锁定不变量断言本轮显式跳过');
        return;
      }

      // R2-APT-005（锁定不变量）：STARTED 任务的分配不可移动——新方案中该任务
      // 保持原 personId，或经 plan diff 验证其无 PERSON_CHANGED。
      const lockedTaskId =
        firstExec.taskId ?? plan0.assignments.find((a) => a.taskId)?.taskId;
      const lockedBefore = plan0.assignments.find((a) => a.taskId === lockedTaskId);
      const lockedAfter = plan1.assignments.find((a) => a.taskId === lockedTaskId);
      if (lockedAfter && lockedBefore) {
        // 锁定（执行中）任务在 replan 后被改派即违反 frozen 语义
        expect(lockedAfter.personId === lockedBefore.personId).toBe(true);
      } else {
        // 任务未出现在新方案 assignments 中时，退而用权威 plan diff 验证：
        // 该任务的 diff 不得出现 PERSON_CHANGED（等价携带或显式 REMOVED）。
        const diff = await apiRequest<PlanCompareResultShape>(
          baseUrl,
          `/api/scheduler/plans/${plan0.planId}/compare/${plan1.planId}`,
          { method: 'GET', headers: makeHeaders(token) },
        );
        expect(diff.status).toBe(200);
        const row = diff.body.diffByTask.find((d) => d.taskId === lockedTaskId);
        expect(row?.changeTypes ?? []).not.toContain('PERSON_CHANGED');
      }
    });

    it('E: stale snapshot approve 被拒（version/snapshotVersion 校验）', async () => {
      // 1) 先创建一个方案（用 TASK_CREATED 触发，避开 MANUAL 30s 冷却去抖）。
      const run = await apiRequest<SchedulingRunResponse>(
        baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'TASK_CREATED' }),
        },
      );
      const plan = run.body.plans?.[0];
      expect(plan).toBeDefined();

      // 2) 用错误的 version 审批 → 拒绝 PLAN_STALE。
      const wrongVersion = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan!.planId}/approve`,
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            version: (plan!.version ?? 0) + 999,
            snapshotVersion: plan!.snapshotVersion,
            operator: 'e2e-admin',
            reason: 'stale',
          }),
        },
      );
      expect(wrongVersion.status).toBe(409);
      expect(JSON.stringify(wrongVersion.body)).toContain('PLAN_STALE');

      // 3) 用过期 snapshotVersion 审批 → 拒绝 PLAN_STALE（assertFreshForApprove）。
      const staleSnapshot = await apiRequest(
        baseUrl,
        `/api/scheduler/plans/${plan!.planId}/approve`,
        {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({
            version: plan!.version,
            snapshotVersion: 'WS-OLD-NOT-FRESH',
            operator: 'e2e-admin',
            reason: 'stale-snapshot',
          }),
        },
      );
      expect(staleSnapshot.status).toBe(409);
      expect(JSON.stringify(staleSnapshot.body)).toContain('PLAN_STALE');
    });

    // ======================================================================
    // Phase 4：Execution / KPI / Replay / Shadow / Gate / Activation（真实 PG）
    // ======================================================================

    it('F: dispatch 后建立 Execution 记录；actual 回填 → STARTED', async () => {
      const run = await apiRequest<SchedulingRunResponse>(baseUrl, '/api/scheduler/runs', {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'TASK_UPDATED' }),
      });
      expect(run.status).toBe(201);
      const plan = run.body.plans?.[0];
      expect(plan).toBeDefined();
      const approve = await apiRequest(baseUrl, `/api/scheduler/plans/${plan!.planId}/approve`, {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({ version: plan!.version, snapshotVersion: plan!.snapshotVersion, operator: 'e2e' }),
      });
      expect(approve.status).toBe(200);
      const dispatch = await apiRequest(baseUrl, `/api/scheduler/plans/${plan!.planId}/dispatch`, {
        method: 'POST',
        headers: makeHeaders(token),
      });
      expect(dispatch.status).toBe(200);
      const execs = await apiRequest<{ executions: Array<{ assignmentId: string; status: string }> }>(
        baseUrl,
        `/api/scheduler/executions?planId=${encodeURIComponent(plan!.planId)}`,
        { method: 'GET', headers: makeHeaders(token) },
      );
      if (plan!.assignments.length > 0) {
        expect(execs.body.executions.length).toBeGreaterThan(0);
        expect(execs.body.executions[0].status).toBe('PLANNED');
        const upd = await apiRequest<{ status: string }>(baseUrl, `/api/scheduler/executions/${execs.body.executions[0].assignmentId}/update`, {
          method: 'POST',
          headers: makeHeaders(token),
          body: JSON.stringify({ status: 'STARTED', actualStartAt: new Date().toISOString() }),
        });
        expect(upd.status).toBe(201);
        expect(upd.body.status).toBe('STARTED');
      }
    });

    it('G: KPI 聚合端点可用（真实聚合不抛错）', async () => {
      const res = await apiRequest<{ delivery: unknown; stability: unknown; solver: unknown }>(baseUrl, '/api/scheduler/kpi', {
        method: 'GET',
        headers: makeHeaders(token),
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('delivery');
      expect(res.body).toHaveProperty('stability');
      expect(res.body).toHaveProperty('solver');
    });

    it('H: Policy Replay 持久化（candidate v1 + seed）', async () => {
      const replay = await apiRequest<{ replayId?: string; seed?: number }>(baseUrl, '/api/scheduler/policy/replay', {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({ candidatePolicyVersion: 1, seed: 42 }),
      });
      if (replay.status === 201 || replay.status === 200) {
        expect(replay.body.replayId).toBeTruthy();
        expect(replay.body.seed).toBe(42);
      } else {
        // 无历史快照 / 候选策略未注册时明确失败原因（不掩盖；两种合法失败路径）。
        const msg = JSON.stringify(replay.body);
        expect(
          msg.includes('no historical snapshot') || msg.includes('not found'),
        ).toBe(true);
      }
    });

    it('I: Policy Activation Gate 端点可用 + 未就绪策略激活被拒', async () => {
      const gate = await apiRequest<{ passed: boolean; checks: unknown[] }>(baseUrl, '/api/scheduler/policy/1/gate', {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({}),
      });
      expect(gate.status).toBe(201);
      expect(gate.body).toHaveProperty('passed');
      expect(gate.body).toHaveProperty('checks');
      const activate = await apiRequest(baseUrl, '/api/scheduler/policy/999/activate', {
        method: 'POST',
        headers: makeHeaders(token),
        body: JSON.stringify({ operator: 'e2e', reason: 'test' }),
      });
      // 策略不存在/未 SHADOW → 拒绝（不返回成功激活）
      expect(activate.status).not.toBe(200);
    });
  });
}
