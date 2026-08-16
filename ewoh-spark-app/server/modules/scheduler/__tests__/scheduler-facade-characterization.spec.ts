/* Task 2（Strangler Refactor）：SchedulerService facade 行为表征测试。
 *
 * 本 spec 是重构 oracle：scheduler.service.ts 拆分为职责单一服务并降级为
 * thin facade 之前/之后都必须通过。只断言公开 API 的行为
 * （返回值形状 / 委托参数 / 错误类型 / 状态副作用），不依赖内部实现细节。
 *
 * 覆盖主路径：generatePlans、confirmPlan、rejectPlan、
 * createRun→getRun→listRuns、approvePlanV2、dispatchPlanV2、rejectPlanV2、
 * replanV2、applyOverrides、getTaskCandidates、listConflicts、
 * executionUpdate、executionList、injectSchedulingEvent、recordTaskActuals，
 * 以及只读查询面（getPlans/getAudit/getActivePlans/getSnapshot/getPlanDetail/
 * getPolicy/listPolicyVersions/comparePolicyVersion/registerPolicyVersion/
 * activatePolicyVersion/listPlanConstraintsV2/deactivateConstraintV2/
 * comparePlansV2/getRoutes/calculateRouteV2/getConflictDetail）。
 */
/// <reference types="jest" />
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SchedulerService } from '../scheduler.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SolverService } from '../solver.service';
import { AuditService } from '../../shared/audit.service';
import { RequestDatabaseContext } from '../../../database/request-database-context';
import {
  ewohSchedulePlan,
  ewohScheduleAudit,
  ewohSchedulingRun,
  ewohSchedulingConstraint,
} from '@server/database/schema';
import type {
  WorldStateSnapshot,
  SchedulingPlanV2,
  SchedulingRun,
  SchedulingPolicyConfig,
  TaskCandidatesResponse,
} from '@shared/api.interface';
import type { OrgContext } from '../../shared/org-context.interceptor';

const ACTOR: OrgContext = {
  userId: 'char-user',
  primaryOrgId: 'org1',
  role: 'dispatcher',
  accessibleOrgIds: ['org1'],
  isGlobalAdmin: false,
};

function makeSnapshot(): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-CHAR-0001',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
  };
}

function planV2(planId: string, status = 'proposed'): SchedulingPlanV2 {
  return {
    planId,
    version: 1,
    status: status as SchedulingPlanV2['status'],
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-CHAR-0001',
    policyVersion: 1,
    solverVersion: 'char-test',
    horizonMinutes: 480,
    assignments: [
      {
        assignmentId: `ASG-${planId}-1`,
        taskId: 't1',
        personId: 'p1',
        deviceId: null,
        stationId: null,
        zoneId: null,
        plannedStart: null,
        plannedEnd: null,
        routeId: null,
        etaSeconds: 120,
        distanceMeters: 100,
        status: 'proposed',
        reasons: [],
        alternatives: [],
      },
    ],
    metrics: {
      lateMinutes: 0,
      walkingMeters: 100,
      stationWaitMinutes: 0,
      maxWorkload: 1,
      changeCost: 0,
    },
    baselineDelta: { variant: { label: 'on_time' } },
    violations: [],
    createdAt: new Date().toISOString(),
  };
}

/** select 链式查询（thenable，支持 where/orderBy/limit/offset）。 */
function queryFor(rowsProvider: () => unknown[]): any {
  const q: any = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    offset: () => q,
    then: (resolve: (v: unknown) => void) => resolve(rowsProvider()),
  };
  return q;
}

interface FakeDbSeed {
  plans?: Array<Record<string, unknown>>;
  audits?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
  onUpdate?: (table: unknown, values: Record<string, unknown>) => unknown[];
  onInsert?: (table: unknown, values: Record<string, unknown>) => unknown[];
}

/** in-memory fake drizzle db：按表身份返回行，支持 update/insert 行为注入。 */
function makeDb(seed: FakeDbSeed = {}): any {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === ewohSchedulePlan) return seed.plans ?? [];
    if (table === ewohScheduleAudit) return seed.audits ?? [];
    if (table === ewohSchedulingRun) return seed.runs ?? [];
    return [];
  };
  const db: any = {
    select: (projection?: unknown) => ({
      from: (table: unknown) => {
        if (projection && table === ewohSchedulingRun) {
          // listRuns count 投影：sql`count(*)::int`
          return queryFor(() => [{ count: (seed.runs ?? []).length }]);
        }
        return queryFor(() => rowsFor(table));
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const obj: any = {
            returning: () =>
              Promise.resolve(
                seed.onUpdate ? seed.onUpdate(table, values) : [],
              ),
          };
          obj.then = (resolve: (v: unknown) => void) => resolve(undefined);
          return obj;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const obj: any = {
          returning: () =>
            Promise.resolve(
              seed.onInsert ? seed.onInsert(table, values) : [],
            ),
        };
        obj.then = (resolve: (v: unknown) => void) => resolve(undefined);
        return obj;
      },
    }),
  };
  return db;
}

/** 完整依赖 fake 集：默认全部可用；按需覆盖以测 fallback 路径。 */
function makeSvc(seed: FakeDbSeed = {}, opts: { noConflict?: boolean; noExecution?: boolean; noCandidateEngine?: boolean; noReplanCoordinator?: boolean; noReplay?: boolean } = {}) {
  const db = makeDb(seed);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<unknown>) => {
      return cb();
    }),
  } as unknown as RequestDatabaseContext;
  const auditService = {
    appendAuditLog: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;

  const planService = {
    getPlan: jest.fn().mockImplementation(async (planId: string) => {
      const row = (seed.plans ?? []).find((p) => p.planId === planId);
      if (!row) throw new Error(`Plan ${planId} not found`);
      return planV2(planId, (row.status as string) ?? 'proposed');
    }),
    // R-5 N+1：listRuns 改用批量加载；mock 保持与 getPlan 同语义（按 seed 富化）。
    listPlansBatched: jest.fn().mockImplementation(async (planIds: string[]) =>
      planIds.map((planId) => {
        const row = (seed.plans ?? []).find((p) => p.planId === planId);
        return planV2(planId, (row?.status as string) ?? 'proposed');
      }),
    ),
    persistPlan: jest.fn().mockResolvedValue(undefined),
    listPlanConstraints: jest.fn().mockResolvedValue([]),
    deactivateConstraint: jest.fn().mockResolvedValue({ ok: true }),
    approvePlan: jest.fn().mockResolvedValue(planV2('P-1', 'approved')),
    rejectPlan: jest.fn().mockResolvedValue(planV2('P-1', 'rejected')),
    dispatchPlan: jest.fn().mockResolvedValue(planV2('P-1', 'dispatched')),
    replan: jest.fn().mockResolvedValue(planV2('P-1', 'proposed')),
    comparePlans: jest.fn().mockResolvedValue({ changed: true }),
    consultReplanApproval: jest.fn().mockReturnValue(null),
  };

  const worldStateSnapshotService = {
    buildSnapshot: jest.fn().mockResolvedValue(makeSnapshot()),
    getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
    isPlanStale: jest.fn().mockResolvedValue(false),
  };

  const triggerService = {
    evaluate: jest.fn().mockResolvedValue({
      runId: 'RUN-1',
      triggerType: 'MANUAL',
      triggerEntityId: null,
    }),
  };
  const solverService = {
    solve: jest.fn(),
    solveVariants: jest.fn().mockResolvedValue([
      planV2('RUN-1A', 'shadow'),
      planV2('RUN-1B', 'shadow'),
      planV2('RUN-1C', 'shadow'),
    ]),
  } as unknown as SolverService;
  const routingService = {
    loadGraph: jest.fn().mockResolvedValue({ version: 1, edges: [], nodes: [] }),
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-1' }),
  };
  const eligibilityService = {
    check: jest.fn().mockReturnValue({ eligible: true, reasons: [] }),
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      distanceMeters: 10,
      etaSeconds: 10,
      feasible: true,
      source: 'route_graph',
      dataQuality: 'FRESH',
      fallbackReason: null,
      geometry: [],
    }),
  };
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue({
      version: 1,
      solverVersion: 'heuristic-v2',
    }),
    getConfig: jest.fn().mockResolvedValue({
      configVersion: 1,
      minBatteryPct: 15,
      maxContinuousLoad: 0.9,
      defaultTaskDurationMs: 1_800_000,
      horizonMinutes: 480,
      priority: {
        deadlineRiskWeight: 1,
        waitingAgeWeight: 0.5,
        eventSeverityWeight: 1,
        productionImpactWeight: 1,
        downstreamBlockingWeight: 1,
        manualBoostWeight: 1,
        agingBaseMs: 3_600_000,
      },
    } as SchedulingPolicyConfig),
    getConfigByVersion: jest.fn().mockResolvedValue({
      configVersion: 2,
      minBatteryPct: 20,
      maxContinuousLoad: 0.9,
      defaultTaskDurationMs: 1_800_000,
      horizonMinutes: 480,
      priority: {
        deadlineRiskWeight: 2,
        waitingAgeWeight: 0.5,
        eventSeverityWeight: 1,
        productionImpactWeight: 1,
        downstreamBlockingWeight: 1,
        manualBoostWeight: 1,
        agingBaseMs: 3_600_000,
      },
    } as SchedulingPolicyConfig),
    listVersions: jest.fn().mockResolvedValue([]),
    registerCandidatePolicy: jest.fn().mockResolvedValue({
      configVersion: 2,
      minBatteryPct: 20,
    }),
    getPolicyVersionStatus: jest.fn().mockResolvedValue({ active: false }),
    activatePolicyVersion: jest.fn().mockResolvedValue({
      configVersion: 2,
      minBatteryPct: 20,
    }),
    resolveReplanApprovalConfig: jest.fn().mockResolvedValue(null),
  };
  const feedbackService = {
    deriveKpis: jest.fn().mockResolvedValue({ acceptanceRate: 0.8 }),
    recordActuals: jest.fn().mockResolvedValue(undefined),
  };
  const outboxService = {
    enqueue: jest.fn().mockResolvedValue({ id: 'EVT-1' }),
  };
  const replanCoordinatorService = opts.noReplanCoordinator
    ? undefined
    : {
        handleTrigger: jest.fn().mockResolvedValue({
          run: { runId: 'RUN-E1', triggerType: 'DEVICE_OFFLINE', status: 'succeeded' },
          plans: [planV2('RUN-E1A', 'proposed')],
          debounced: false,
        }),
        dispatchStateTriggers: jest.fn().mockResolvedValue([
          { triggerType: 'ROUTE_BLOCKED', entityId: 'e1' },
        ]),
        analyzeImpactV2: jest.fn().mockResolvedValue([]),
      };
  const metricsService = {
    recordRun: jest.fn(),
    recordFallback: jest.fn(),
  };
  const conflictService = opts.noConflict
    ? undefined
    : {
        listConflicts: jest.fn().mockResolvedValue({ conflicts: [], total: 0 }),
        getConflictDetail: jest.fn().mockRejectedValue(new NotFoundException('Conflict x not found')),
      };
  const policyReplayService = opts.noReplay
    ? undefined
    : {
        evaluate: jest.fn().mockResolvedValue(null),
        isEvaluated: jest.fn().mockReturnValue(true),
      };
  const executionService = opts.noExecution
    ? undefined
    : {
        update: jest.fn().mockResolvedValue({
          executionId: 'EXEC-1',
          assignmentId: 'ASG-1',
          status: 'running',
        }),
        list: jest.fn().mockResolvedValue({ executions: [], total: 0 }),
        createFromPlan: jest.fn().mockResolvedValue(undefined),
      };
  const constraintLoaderService = {
    loadGlobalActive: jest.fn().mockResolvedValue([]),
  };
  const candidateEngineService = opts.noCandidateEngine
    ? undefined
    : {
        evaluateTaskCandidates: jest.fn().mockResolvedValue({
          taskId: 't1',
          taskTitle: 't1',
          taskStatus: 'pending',
          assigned: false,
          lockedAssigneeId: null,
          lockedDeviceId: null,
          solverVersion: 'candidate-engine-v1',
          candidates: [],
          generatedAt: new Date().toISOString(),
        } as TaskCandidatesResponse),
      };
  const replanPreviewService = {
    previewReplan: jest.fn().mockResolvedValue(null),
  };

  const svc = new SchedulerService(
    db,
    requestDatabaseContext,
    auditService,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    triggerService as never,
    solverService,
    planService as unknown as PlanService,
    routingService as never,
    eligibilityService as never,
    routeCostProvider as never,
    policyService as never,
    feedbackService as never,
    outboxService as never,
    replanCoordinatorService as never,
    metricsService as never,
    conflictService as never,
    policyReplayService as never,
    executionService as never,
    constraintLoaderService as never,
    candidateEngineService as never,
    replanPreviewService as never,
  );

  return {
    svc,
    db,
    mocks: {
      requestDatabaseContext,
      auditService,
      planService,
      worldStateSnapshotService,
      triggerService,
      solverService,
      routingService,
      eligibilityService,
      routeCostProvider,
      policyService,
      feedbackService,
      outboxService,
      replanCoordinatorService,
      metricsService,
      conflictService,
      policyReplayService,
      executionService,
      constraintLoaderService,
      candidateEngineService,
    },
  };
}

const PLAN_ROW = {
  id: 'row-1',
  planId: 'P-1',
  planName: 'plan',
  strategy: 'keep_status',
  status: 'proposed',
  taktImprovement: 0,
  highLoadPersons: 0,
  lowBatteryRisk: 0,
  affectedPersons: 1,
  metricsJson: null,
  reason: null,
  createdAt: new Date(),
  confirmedBy: null,
  confirmedAt: null,
  confirmReason: null,
};

const RUN_ROW = {
  runId: 'RUN-1',
  triggerType: 'MANUAL',
  triggerEntityId: null,
  status: 'succeeded',
  snapshotVersion: 'WS-CHAR-0001',
  planIds: ['RUN-1A', 'RUN-1B', 'RUN-1C'],
  orgId: 'org1',
  error: null,
  failureReason: null,
  createdAt: new Date(),
};

const AUDIT_ROW = {
  id: 'audit-1',
  auditId: 'AUDIT-1',
  planId: 'P-1',
  action: 'confirm',
  operator: 'op',
  reason: 'ok',
  createdAt: new Date(),
};

describe('SchedulerService facade 行为表征（重构 oracle）', () => {
  describe('legacy 合成链路', () => {
    it('generatePlans 委托 createRun 并映射 legacy 形状（metricsJson 透传真实指标）', async () => {
      const { svc } = makeSvc();
      const plans = await svc.generatePlans({ idempotencyKey: 'k' });
      expect(plans).toHaveLength(3);
      expect(plans[0].planId).toBe('RUN-1A');
      expect(plans[0].metricsJson).toMatchObject({ solverStatus: undefined, assignmentCount: 1 });
      expect(plans[0].createdAt).toBeTruthy();
    });

    it('getPlans 返回按创建时间倒序的 legacy 方案', async () => {
      const { svc } = makeSvc({ plans: [PLAN_ROW] });
      const rows = await svc.getPlans('proposed');
      expect(rows).toHaveLength(1);
      expect(rows[0].planId).toBe('P-1');
      expect(rows[0].status).toBe('proposed');
    });

    it('getAudit 按 planId 过滤返回审计行', async () => {
      const { svc } = makeSvc({ audits: [AUDIT_ROW] });
      const rows = await svc.getAudit('P-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].auditId).toBe('AUDIT-1');
      expect(rows[0].action).toBe('confirm');
    });
  });

  describe('confirmPlan / rejectPlan（状态机 + 审计）', () => {
    const updatedPlan = { ...PLAN_ROW, status: 'confirmed', confirmedBy: 'op', confirmedAt: new Date(), confirmReason: 'ok' };
    const updatedReject = { ...PLAN_ROW, status: 'rejected', confirmedBy: 'op', confirmedAt: new Date(), confirmReason: 'no' };

    it('confirmPlan 事务内更新 + 写审计 + appendAuditLog', async () => {
      const { svc, mocks } = makeSvc({
        plans: [PLAN_ROW],
        onUpdate: () => [updatedPlan],
        onInsert: (_t, v) => [{ ...AUDIT_ROW, ...(v as object) }],
      });
      const res = await svc.confirmPlan('P-1', 'ok', 'op', ACTOR);
      expect(res.plan.status).toBe('confirmed');
      expect(res.audit.action).toBe('confirm');
      expect(mocks.auditService.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'scheduler.confirm', entityId: 'P-1' }),
      );
    });

    it('confirmPlan 缺 reason → BadRequestException', async () => {
      const { svc } = makeSvc({ plans: [PLAN_ROW] });
      await expect(svc.confirmPlan('P-1', '  ')).rejects.toThrow(BadRequestException);
    });

    it('confirmPlan 方案不存在 → NotFoundException', async () => {
      const { svc } = makeSvc();
      await expect(svc.confirmPlan('NOPE', 'ok')).rejects.toThrow(NotFoundException);
    });

    it('confirmPlan 条件更新 0 行 → ConflictException(STATE_CONFLICT)', async () => {
      const { svc } = makeSvc({ plans: [PLAN_ROW], onUpdate: () => [] });
      await expect(svc.confirmPlan('P-1', 'ok', 'op', ACTOR)).rejects.toThrow(ConflictException);
    });

    it('rejectPlan 置 rejected 并审计', async () => {
      const { svc, mocks } = makeSvc({
        plans: [PLAN_ROW],
        onUpdate: () => [updatedReject],
        onInsert: (_t, v) => [{ ...AUDIT_ROW, action: 'reject', ...(v as object) }],
      });
      const res = await svc.rejectPlan('P-1', 'no', 'op', ACTOR);
      expect(res.plan.status).toBe('rejected');
      expect(res.audit.action).toBe('reject');
      expect(mocks.auditService.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'scheduler.reject' }),
      );
    });
  });

  describe('createRun → getRun → listRuns 生命周期', () => {
    it('createRun 全链路：trigger 评估 → 快照 → 约束加载 → 求解 → persist → run succeeded', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.createRun({ trigger: 'MANUAL' }, ACTOR);
      expect(res.debounced).toBe(false);
      expect(res.run?.runId).toBe('RUN-1');
      expect(res.plans.map((p) => p.planId)).toEqual(['RUN-1A', 'RUN-1B', 'RUN-1C']);
      expect(mocks.triggerService.evaluate).toHaveBeenCalledWith('MANUAL', null, expect.any(Object));
      expect(mocks.solverService.solveVariants).toHaveBeenCalledWith(
        expect.any(Object),
        [],
        expect.objectContaining({ planId: 'RUN-1', triggerType: 'MANUAL' }),
      );
      expect(mocks.planService.persistPlan).toHaveBeenCalledTimes(3);
      expect(mocks.constraintLoaderService.loadGlobalActive).toHaveBeenCalled();
    });

    it('createRun trigger 去抖（evaluate 返回 null）→ debounced 空结果', async () => {
      const { svc, mocks } = makeSvc();
      mocks.triggerService.evaluate.mockResolvedValue(null);
      const res = await svc.createRun({ trigger: 'MANUAL' }, ACTOR);
      expect(res).toEqual({ run: null, plans: [], debounced: true });
    });

    it('createRun mode=SHADOW → 不 persist plan、run.planIds=[]', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.createRun({ trigger: 'MANUAL', mode: 'SHADOW' }, ACTOR);
      expect(mocks.planService.persistPlan).not.toHaveBeenCalled();
      expect(res.plans).toHaveLength(3);
      // run 状态更新为 succeeded 且 planIds 为空
      expect(res.run?.runId).toBe('RUN-1');
    });

    it('createRun objectiveProfile=on_time → 只保留 A 变体', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.createRun({ trigger: 'MANUAL', objectiveProfile: 'on_time' }, ACTOR);
      expect(res.plans.map((p) => p.planId)).toEqual(['RUN-1A']);
      expect(mocks.planService.persistPlan).toHaveBeenCalledTimes(1);
    });

    it('getRun 返回映射后的 run；不存在 → null', async () => {
      const { svc } = makeSvc({ runs: [RUN_ROW] });
      const run = await svc.getRun('RUN-1');
      expect(run?.runId).toBe('RUN-1');
      expect(run?.triggerType).toBe('MANUAL');
      expect(run?.planIds).toEqual(['RUN-1A', 'RUN-1B', 'RUN-1C']);
      // fake db 不模拟 where 过滤：用无行种子验证缺省路径
      const { svc: empty } = makeSvc({ runs: [] });
      const missing = await empty.getRun('NOPE');
      expect(missing).toBeNull();
    });

    it('listRuns 分页 + 活跃方案（非终态）', async () => {
      const { svc, mocks } = makeSvc({
        runs: [RUN_ROW],
        plans: [PLAN_ROW, { ...PLAN_ROW, planId: 'P-2', status: 'approved' }],
      });
      mocks.planService.getPlan.mockImplementation(async (planId: string) =>
        planV2(planId, planId === 'P-2' ? 'approved' : 'proposed'),
      );
      const res = await svc.listRuns({ page: 1, pageSize: 20 }, ACTOR);
      expect(res.runs).toHaveLength(1);
      expect(res.total).toBe(1);
      expect(res.page).toBe(1);
      expect(res.pageSize).toBe(20);
      expect(res.plans.length).toBeGreaterThanOrEqual(1);
    });

    it('getActivePlans 读取活跃方案并经批量加载富化（R-5 N+1）', async () => {
      const { svc, mocks } = makeSvc({
        plans: [PLAN_ROW, { ...PLAN_ROW, planId: 'P-2', status: 'approved' }],
      });
      mocks.planService.listPlansBatched.mockImplementation(async (planIds: string[]) =>
        planIds.map((planId) => planV2(planId, planId === 'P-2' ? 'approved' : 'proposed')),
      );
      const plans = await svc.getActivePlans();
      expect(plans.map((p) => p.planId)).toEqual(expect.arrayContaining(['P-1', 'P-2']));
      expect(mocks.planService.listPlansBatched).toHaveBeenCalledWith(
        expect.arrayContaining(['P-1', 'P-2']),
      );
    });
  });

  describe('只读查询面', () => {
    it('getSnapshot 包装 CURRENT 快照', async () => {
      const { svc } = makeSvc();
      const snap = await svc.getSnapshot();
      expect(snap.snapshotVersion).toBe('CURRENT');
      expect(snap.ts).toBeTruthy();
    });

    it('getPlanDetail 委托 planService.getPlan', async () => {
      const { svc, mocks } = makeSvc({ plans: [PLAN_ROW] });
      const plan = await svc.getPlanDetail('P-1');
      expect(plan.planId).toBe('P-1');
      // ADR-071：actor 可选透传（无 actor 时为 undefined）。
      expect(mocks.planService.getPlan).toHaveBeenCalledWith('P-1', undefined);
    });

    it('getPolicy 返回 { policy, config }', async () => {
      const { svc } = makeSvc();
      const res = await svc.getPolicy();
      expect(res.policy.solverVersion).toBe('heuristic-v2');
      expect(res.config.configVersion).toBe(1);
    });

    it('listPolicyVersions 委托 policyService.listVersions', async () => {
      const { svc, mocks } = makeSvc();
      mocks.policyService.listVersions.mockResolvedValue([
        { configVersion: 1, active: true, updatedBy: 'u', createdAt: '' },
      ]);
      const versions = await svc.listPolicyVersions();
      expect(versions).toHaveLength(1);
      expect(versions[0].configVersion).toBe(1);
    });

    it('comparePolicyVersion 计算 paramDeltas + objective + verdict（readOnly）', async () => {
      const { svc } = makeSvc();
      const cmp = await svc.comparePolicyVersion(2, ACTOR);
      expect(cmp.candidateVersion).toBe(2);
      expect(cmp.activeVersion).toBe(1);
      expect(cmp.readOnly).toBe(true);
      expect(cmp.paramDeltas['minBatteryPct']).toEqual({ active: 15, candidate: 20 });
      expect(cmp.paramDeltas['priority.deadlineRiskWeight']).toEqual({ active: 1, candidate: 2 });
      expect(typeof cmp.verdict).toBe('string');
    });

    it('comparePolicyVersion 版本不存在 → NotFoundException', async () => {
      const { svc, mocks } = makeSvc();
      mocks.policyService.getConfigByVersion.mockResolvedValue(null);
      await expect(svc.comparePolicyVersion(99, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('getRoutes 委托 routingService.loadGraph', async () => {
      const { svc } = makeSvc();
      const graph = await svc.getRoutes();
      expect(graph).toEqual({ version: 1, edges: [], nodes: [] });
    });

    it('calculateRouteV2 单点模式委托 routingService.calculateRoute', async () => {
      const { svc, mocks } = makeSvc();
      const route = await svc.calculateRouteV2({ personId: 'p1', taskId: 't1' });
      expect(route).toEqual({ routeId: 'ROUTE-1' });
      expect(mocks.routingService.calculateRoute).toHaveBeenCalledWith('p1', 't1');
    });

    it('calculateRouteV2 批量候选模式返回 RouteCandidatesResponse', async () => {
      const { svc, mocks } = makeSvc();
      mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
        ...makeSnapshot(),
        stations: [{ id: 's1', x: 0, y: 0 }],
        tasks: [{ id: 't1', stationId: 's1' }],
        persons: [{ id: 'p1', stationId: 's1' }],
      });
      const res = await svc.calculateRouteV2({
        personId: 'p1',
        taskId: 't1',
        candidates: [{ personId: 'p1', deviceId: null, stationId: null }],
      });
      expect(res).toMatchObject({ data: { taskId: 't1', candidates: [{ personId: 'p1', feasible: true }] } });
    });

    it('getTaskCandidates（注入 candidateEngine）→ 委托富化响应', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.getTaskCandidates('t1');
      expect(res.solverVersion).toBe('candidate-engine-v1');
      expect(mocks.candidateEngineService.evaluateTaskCandidates).toHaveBeenCalledWith('t1');
    });

    it('getTaskCandidates（未注入 candidateEngine）→ 回退旧逻辑（资格+路由+排序）', async () => {
      const { svc, mocks } = makeSvc({}, { noCandidateEngine: true });
      mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
        ...makeSnapshot(),
        stations: [{ id: 's1', x: 0, y: 0, capacity: 2 }],
        tasks: [
          { id: 't1', title: 'T1', taskType: 'work', status: 'pending', stationId: 's1', requiredSkills: ['work'], requiredCertifications: [], requiredDeviceCapabilities: [], predecessorIds: [] },
        ],
        persons: [{ id: 'p1', name: 'P1', status: 'AVAILABLE', skills: ['work'], certifications: [], stationId: 's1', loadLevel: 0 }],
        devices: [],
      });
      mocks.eligibilityService.check.mockReturnValue({ eligible: true, reasons: [] });
      const res = await svc.getTaskCandidates('t1');
      expect(res.taskId).toBe('t1');
      expect(res.candidates.length).toBeGreaterThanOrEqual(1);
      expect(res.candidates[0].personId).toBe('p1');
      expect(res.candidates[0].eligible).toBe(true);
    });

    it('getTaskCandidates 任务不存在 → NotFoundException', async () => {
      const { svc } = makeSvc({}, { noCandidateEngine: true });
      await expect(svc.getTaskCandidates('NOPE')).rejects.toThrow(NotFoundException);
    });

    it('listPlanConstraintsV2 / deactivateConstraintV2 委托 planService', async () => {
      const { svc, mocks } = makeSvc();
      await svc.listPlanConstraintsV2('P-1');
      // ADR-072：actor 可选透传（无 actor 时为 undefined）。
      expect(mocks.planService.listPlanConstraints).toHaveBeenCalledWith('P-1', undefined);
      await svc.deactivateConstraintV2('C-1', ACTOR, 'reason');
      expect(mocks.planService.deactivateConstraint).toHaveBeenCalledWith(
        'C-1',
        expect.objectContaining({ userId: 'char-user' }),
        'reason',
      );
    });

    it('comparePlansV2 委托 planService.comparePlans', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.comparePlansV2('P-1', 'P-2');
      expect(res).toEqual({ changed: true });
      expect(mocks.planService.comparePlans).toHaveBeenCalledWith('P-1', 'P-2');
    });
  });

  describe('V2 方案应用（approve / reject / dispatch / replan）', () => {
    it('approvePlanV2 委托 planService.approvePlan（无 CAS 时）', async () => {
      const { svc, mocks } = makeSvc();
      const plan = await svc.approvePlanV2('P-1', { version: 1, snapshotVersion: 'WS-CHAR-0001' }, ACTOR);
      expect(plan.status).toBe('approved');
      expect(mocks.planService.approvePlan).toHaveBeenCalledWith(
        'P-1',
        { version: 1, snapshotVersion: 'WS-CHAR-0001' },
        expect.objectContaining({ userId: 'char-user' }),
      );
    });

    it('approvePlanV2 expectedPlanVersion 不一致 → ConflictException(STALE_PLAN)', async () => {
      const { svc } = makeSvc();
      await expect(
        svc.approvePlanV2('P-1', { version: 1, expectedPlanVersion: 2, snapshotVersion: 'WS' }, ACTOR),
      ).rejects.toThrow(ConflictException);
    });

    it('rejectPlanV2 委托 planService.rejectPlan', async () => {
      const { svc, mocks } = makeSvc();
      const plan = await svc.rejectPlanV2('P-1', { reason: 'no' }, ACTOR);
      expect(plan.status).toBe('rejected');
      expect(mocks.planService.rejectPlan).toHaveBeenCalled();
    });

    it('dispatchPlanV2 委托 dispatch + 创建 Execution 记录', async () => {
      const { svc, mocks } = makeSvc();
      const plan = await svc.dispatchPlanV2('P-1', ACTOR);
      expect(plan.status).toBe('dispatched');
      expect(mocks.planService.dispatchPlan).toHaveBeenCalledWith('P-1', expect.any(Object));
      expect(mocks.executionService.createFromPlan).toHaveBeenCalledTimes(1);
    });

    it('dispatchPlanV2 未注入 executionService → 静默跳过', async () => {
      const { svc, mocks } = makeSvc({}, { noExecution: true });
      const plan = await svc.dispatchPlanV2('P-1', ACTOR);
      expect(plan.status).toBe('dispatched');
      expect(mocks.planService.dispatchPlan).toHaveBeenCalled();
    });

    it('replanV2 委托 planService.replan', async () => {
      const { svc, mocks } = makeSvc();
      const plan = await svc.replanV2('P-1', { lockedConstraints: [], reason: 'r' }, ACTOR);
      expect(plan.planId).toBe('P-1');
      expect(mocks.planService.replan).toHaveBeenCalledWith(
        'P-1',
        { lockedConstraints: [], reason: 'r' },
        expect.objectContaining({ userId: 'char-user' }),
      );
    });
  });

  describe('策略生命周期（register / activate）', () => {
    it('registerPolicyVersion 委托 policyService.registerCandidatePolicy（inactive）', async () => {
      const { svc, mocks } = makeSvc();
      const config = { configVersion: 99 } as SchedulingPolicyConfig;
      const saved = await svc.registerPolicyVersion(config, ACTOR);
      expect(saved.configVersion).toBe(2);
      expect(mocks.policyService.registerCandidatePolicy).toHaveBeenCalledWith(config, 'org1', 'char-user');
    });

    it('activatePolicyVersion 守卫齐全（approver/reason/非 active/已评估）→ 激活 + 审计', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.activatePolicyVersion(2, { approver: 'op', reason: 'r' }, ACTOR);
      expect(res.config.configVersion).toBe(2);
      expect(mocks.policyService.activatePolicyVersion).toHaveBeenCalledWith(2, 'org1', 'op', 'r');
      expect(mocks.auditService.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'scheduler.policy.activate' }),
      );
    });

    it('activatePolicyVersion 缺 approver → BadRequestException', async () => {
      const { svc } = makeSvc();
      await expect(svc.activatePolicyVersion(2, { reason: 'r' }, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('activatePolicyVersion 已激活版本 → ConflictException(POLICY_ALREADY_ACTIVE)', async () => {
      const { svc, mocks } = makeSvc();
      mocks.policyService.getPolicyVersionStatus.mockResolvedValue({ active: true });
      await expect(svc.activatePolicyVersion(2, { approver: 'op', reason: 'r' }, ACTOR)).rejects.toThrow(
        ConflictException,
      );
    });

    it('activatePolicyVersion 未完成 replay 评估 → ConflictException(POLICY_NOT_EVALUATED)', async () => {
      const { svc } = makeSvc({}, { noReplay: true });
      await expect(svc.activatePolicyVersion(2, { approver: 'op', reason: 'r' }, ACTOR)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('applyOverrides（人工覆盖 → 约束落库 → 重排 → diff）', () => {
    it('合法覆盖：落库约束 + 审计 + replan + 差异摘要', async () => {
      const before = planV2('P-1', 'proposed');
      const after = planV2('P-1', 'proposed');
      const { svc, mocks } = makeSvc({
        plans: [PLAN_ROW],
        onUpdate: () => [],
        onInsert: () => [],
      });
      mocks.planService.getPlan.mockResolvedValue(before);
      mocks.planService.replan.mockResolvedValue(after);
      const res = await svc.applyOverrides(
        'P-1',
        { actions: [{ kind: 'LOCK_PERSON', taskId: 't1', personId: 'p9' }], reason: 'manual' },
        ACTOR,
      );
      expect(res.planId).toBe('P-1');
      expect(res.operator).toBe('char-user');
      expect(res.appliedConstraints).toHaveLength(1);
      expect(res.appliedConstraints[0].type).toBe('LOCKED_PERSON');
      expect(res.before).toEqual(before);
      expect(res.after).toEqual(after);
      expect(res.diff).toMatchObject({
        changedTaskIds: [],
        addedTaskIds: [],
        removedTaskIds: [],
      });
      expect(res.preview).toBeNull();
      expect(mocks.auditService.appendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'scheduler.plan.override' }),
      );
    });

    it('方案不存在 → NotFoundException', async () => {
      const { svc } = makeSvc();
      await expect(
        svc.applyOverrides('NOPE', { actions: [], reason: 'r' }, ACTOR),
      ).rejects.toThrow(NotFoundException);
    });

    it('终态方案不可重排 → ConflictException(PLAN_NOT_REPLANNABLE)', async () => {
      const { svc } = makeSvc({ plans: [{ ...PLAN_ROW, status: 'done' }] });
      await expect(
        svc.applyOverrides('P-1', { actions: [], reason: 'r' }, ACTOR),
      ).rejects.toThrow(ConflictException);
    });

    it('expectedPlanVersion 不一致 → ConflictException(STALE_PLAN)', async () => {
      const { svc } = makeSvc({ plans: [PLAN_ROW] });
      await expect(
        svc.applyOverrides(
          'P-1',
          { actions: [], reason: 'r', expectedPlanVersion: 99 },
          ACTOR,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('冲突聚合（listConflicts / getConflictDetail）', () => {
    it('注入 conflictService → 委托', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.listConflicts({});
      expect(res).toEqual({ conflicts: [], total: 0 });
      expect(mocks.conflictService.listConflicts).toHaveBeenCalledWith({});
    });

    it('未注入 conflictService → 回退内存推导（double booking / low battery / stale plan）', async () => {
      const { svc, mocks } = makeSvc({}, { noConflict: true });
      mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
        ...makeSnapshot(),
        reservations: [
          { reservationId: 'r1', resourceType: 'person', resourceId: 'p1', startMs: 100, endMs: 200 },
          { reservationId: 'r2', resourceType: 'person', resourceId: 'p1', startMs: 150, endMs: 250 },
        ],
        devices: [{ id: 'd1', batteryPct: 5, online: true, status: 'AVAILABLE', dataQuality: 'FRESH' }],
      });
      const res = await svc.listConflicts({});
      expect(res.total).toBeGreaterThanOrEqual(2);
      expect(res.conflicts.some((c) => c.type === 'double_booking')).toBe(true);
      expect(res.conflicts.some((c) => c.type === 'low_battery')).toBe(true);
      expect(res.conflicts.every((c) => c.conflictId.startsWith('CFL-'))).toBe(true);
    });

    it('未注入 conflictService → 新冲突经 outbox 推送 conflict.detected（去重）', async () => {
      const { svc, mocks } = makeSvc({}, { noConflict: true });
      mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
        ...makeSnapshot(),
        devices: [{ id: 'd1', batteryPct: 5, online: true, status: 'AVAILABLE', dataQuality: 'FRESH' }],
      });
      await svc.listConflicts({});
      const first = mocks.outboxService.enqueue.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      await svc.listConflicts({});
      expect(mocks.outboxService.enqueue.mock.calls.length).toBe(first);
      expect(mocks.outboxService.enqueue).toHaveBeenCalledWith(
        'conflict.detected',
        expect.stringContaining('CFL-'),
        expect.objectContaining({ type: 'low_battery' }),
        null,
      );
    });

    it('getConflictDetail 未注入 conflictService → 从推导列表查找；不存在抛 NotFound', async () => {
      const { svc } = makeSvc({}, { noConflict: true });
      await expect(svc.getConflictDetail('CFL-nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('执行领域（executionUpdate / executionList）', () => {
    it('executionUpdate 委托 executionService.update（orgId 透传）', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.executionUpdate(
        'ASG-1',
        { status: 'running' } as never,
        ACTOR,
      );
      expect(res).toMatchObject({ assignmentId: 'ASG-1', status: 'running' });
      expect(mocks.executionService.update).toHaveBeenCalledWith(
        'ASG-1',
        { status: 'running' },
        'org1',
      );
    });

    it('executionUpdate 未注入 executionService → 抛错', async () => {
      const { svc } = makeSvc({}, { noExecution: true });
      await expect(
        svc.executionUpdate('ASG-1', { status: 'running' } as never, ACTOR),
      ).rejects.toThrow('executionService not injected');
    });

    it('executionList 委托 executionService.list', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.executionList({ planId: 'P-1', limit: 10 });
      expect(res).toEqual({ executions: [], total: 0 });
      // ADR-073：queryService 转发时合并 orgId（无 actor → null）。
      expect(mocks.executionService.list).toHaveBeenCalledWith({
        planId: 'P-1',
        limit: 10,
        orgId: null,
      });
    });

    it('executionList 未注入 executionService → 抛错', async () => {
      const { svc } = makeSvc({}, { noExecution: true });
      await expect(svc.executionList({})).rejects.toThrow('executionService not injected');
    });
  });

  describe('事件驱动（injectSchedulingEvent / recordTaskActuals）', () => {
    it('injectSchedulingEvent 委托 replanCoordinator + 级联 + metrics 埋点', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.injectSchedulingEvent(
        { trigger: 'DEVICE_OFFLINE', entityId: 'd1' },
        ACTOR,
      );
      expect(mocks.replanCoordinatorService.handleTrigger).toHaveBeenCalledWith(
        'DEVICE_OFFLINE',
        'd1',
        expect.any(Object),
      );
      expect(mocks.replanCoordinatorService.dispatchStateTriggers).toHaveBeenCalledTimes(1);
      expect(res.cascaded).toEqual(['ROUTE_BLOCKED']);
      expect(res.run?.runId).toBe('RUN-E1');
      expect(mocks.metricsService.recordRun).toHaveBeenCalled();
    });

    it('缺失 replanCoordinatorService → 返回空结果不抛错', async () => {
      const { svc } = makeSvc({}, { noReplanCoordinator: true });
      const res = await svc.injectSchedulingEvent({ trigger: 'SAFETY_EVENT' }, ACTOR);
      expect(res).toEqual({ run: null, plans: [], debounced: true, cascaded: [] });
    });

    it('recordTaskActuals 委托 feedbackService.recordActuals + 推送 execution.deviation', async () => {
      const { svc, mocks } = makeSvc();
      const res = await svc.recordTaskActuals(
        { taskId: 't1', actualStart: '2026-08-09T10:00:00Z' },
        ACTOR,
      );
      // NO-13a / ADR-050：响应 additive 透出推进 summary（stub 返回 undefined → 兜底零值）。
      expect(res).toEqual({
        ok: true,
        matched: true,
        advancedAssignments: 0,
        advancedTaskSteps: 0,
        skips: [],
      });
      expect(mocks.feedbackService.recordActuals).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't1', actualStart: '2026-08-09T10:00:00Z' }),
        expect.any(Object),
      );
      expect(mocks.outboxService.enqueue).toHaveBeenCalledWith(
        'execution.deviation',
        't1',
        expect.any(Object),
        'org1',
      );
    });

    it('recordTaskActuals 无匹配键 → BadRequestException', async () => {
      const { svc } = makeSvc();
      await expect(svc.recordTaskActuals({}, ACTOR)).rejects.toThrow(BadRequestException);
    });
  });
});
