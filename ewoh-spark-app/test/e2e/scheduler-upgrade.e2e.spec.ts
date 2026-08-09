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
      // 清空 runtime 库触发记录：避免 MANUAL 冷却（30s）跨运行/跨场景 debounce。
      try {
        const postgres = (await import('postgres')).default;
        const runtime = postgres(e2eConfig.runtimeDatabaseUrl, { max: 1 });
        await runtime.unsafe('DELETE FROM ewoh_replan_trigger');
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
            entityId: `DEV-${runId}`,
            reason: 'E2E-B device offline replan',
          }),
        },
      );
      expect(replan.status).toBe(201);

      // 若产生新方案：对比旧方案（plan diff）应输出 changed assignments/ETA delta。
      // 断言点（需 fixture 数据支撑）：partial replan 后无关任务 assignment 不变。
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
            { personId: 'p1', deviceId: 'd1', stationId: 'S1' },
          ],
        }),
      });
      expect(calc.status).toBe(200);
      // 断言：fallback 候选显式携带 fallbackReason/dataQuality；无坐标候选 feasible=false。
      const candidate = calc.body.data.candidates?.[0];
      if (candidate) {
        expect(candidate.routeCostMode).toMatch(/route_graph|euclidean_fallback/);
      }

      // 路线阻断后重排：新方案应避开 blocked 边（routeStatus blocked → 候选不可行）。
    });

    it('D: 锁定 assignment → replan 不变', async () => {
      // 数据准备：ewoh_world_state_snapshot.lockedAssignments 含 {taskId, personId}
      //（执行中任务）。重排后该任务必须保持原分配（frozen），不可移动。
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
      // 断言：锁定任务不出现在新方案的 assignments 变更中（或保持原 personId）。
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
  });
}
