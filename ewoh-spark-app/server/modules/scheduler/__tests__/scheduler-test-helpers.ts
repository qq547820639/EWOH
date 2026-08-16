/* 调度模块测试共享辅助（非 spec，不会被 jest 运行为测试）。
 *
 * 复用 scheduler-domain.spec.ts 的 seed 构造风格，供 Task 4.1 新增的各 spec 共用。
 */
/// <reference types="jest" />
import { EligibilityService, type EligibilityContext } from '../eligibility.service';
import { SolverService, type SolveOptions } from '../solver.service';
import { RoutingService } from '../routing.service';
import { RouteCostProvider } from '../route-cost.provider';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import type {
  WorldStateSnapshot,
  SchedulingPolicy,
  SchedulingPolicyConfig,
} from '@shared/api.interface';

/* ===== 测试数据 seed ===== */

export interface PersonSeed {
  id: string;
  skills?: string[];
  load?: number;
  status?: string;
  certifications?: string[];
}

export interface TaskSeed {
  id: string;
  taskType?: string;
  priority?: string;
  status?: string;
  planStart?: string | null;
  planEnd?: string | null;
  predecessorIds?: string[];
  requiredSkills?: string[];
  requiredCertifications?: string[];
  requiredDeviceCapabilities?: string[];
  candidateStations?: string[];
  zoneId?: string | null;
}

export interface DeviceSeed {
  id: string;
  online?: boolean;
  battery?: number;
  status?: string | null;
}

export function person(seed: PersonSeed) {
  return {
    id: seed.id,
    name: seed.id,
    status: seed.status ?? 'AVAILABLE',
    healthStatus: 'normal',
    skills: seed.skills ?? ['work'],
    certifications: seed.certifications ?? [],
    loadLevel: seed.load ?? 0,
    fatigueLevel: 0,
    stationId: null,
    zoneId: null,
    x: 0,
    y: 0,
  };
}

export function task(seed: TaskSeed) {
  return {
    id: seed.id,
    title: seed.id,
    taskType: seed.taskType ?? 'work',
    priority: seed.priority ?? 'medium',
    status: seed.status ?? 'pending',
    assigneeId: null,
    deviceId: null,
    stationId: null,
    zoneId: seed.zoneId ?? null,
    planStart: seed.planStart ?? null,
    planEnd: seed.planEnd ?? null,
    progress: 0,
    predecessorIds: seed.predecessorIds ?? [],
    requiredSkills: seed.requiredSkills ?? [seed.taskType ?? 'work'],
    requiredCertifications: seed.requiredCertifications ?? [],
    ...(seed.requiredDeviceCapabilities
      ? { requiredDeviceCapabilities: seed.requiredDeviceCapabilities }
      : {}),
    ...(seed.candidateStations ? { candidateStations: seed.candidateStations } : {}),
  };
}

export function device(seed: DeviceSeed) {
  return {
    id: seed.id,
    workerName: null,
    deviceModel: null,
    batteryPct: seed.battery ?? 100,
    online: seed.online ?? true,
    status: seed.status ?? 'AVAILABLE',
  };
}

export function buildSnapshot(overrides: Partial<WorldStateSnapshot>): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
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
    ...overrides,
  };
}

export function defaultPolicy(): SchedulingPolicy {
  return {
    version: 1,
    latenessWeight: 1,
    walkingWeight: 1,
    workloadBalanceWeight: 1,
    stationWaitWeight: 1,
    changeCostWeight: 1,
    riskWeight: 1,
    energyWeight: 1,
    solverVersion: 'heuristic-v2',
    // Phase 2 / P2-T2：权威 8 权重（与旧字段一致，全 1）。
    weights: {
      lateness: 1,
      travel: 1,
      wait: 1,
      workload: 1,
      station: 1,
      change: 1,
      risk: 1,
      energy: 1,
    },
  };
}

export function defaultConfig(): SchedulingPolicyConfig {
  return {
    configVersion: 1,
    minBatteryPct: 15,
    maxContinuousLoad: 0.9,
    defaultTaskDurationMs: 1_800_000,
    horizonMinutes: 480,
    walkingSpeedMps: 1,
    euclideanDistanceWeight: 1,
    congestedFactor: 1.5,
    blockedFactor: 2,
    highRiskFactor: 2,
    mediumRiskFactor: 1.3,
    triggerCooldownMs: 30_000,
    priority: {
      deadlineRiskWeight: 1,
      waitingAgeWeight: 0.5,
      eventSeverityWeight: 1,
      productionImpactWeight: 1,
      downstreamBlockingWeight: 1,
      manualBoostWeight: 1,
      agingBaseMs: 3_600_000,
    },
  };
}

export const baseSolveOpts: SolveOptions = {
  planId: 'P',
  triggerType: 'MANUAL',
  triggerEntityId: null,
  snapshotVersion: 'WS-TEST-0001',
  horizonMinutes: 480,
};

/** 构造 SolverService 所需的最小 mock 依赖，并返回依赖以便测试按需改写。
 *  默认注入一个立即失败的 fetch，使 CP-SAT 尝试安全回退到启发式（保持单测离网、确定性）。
 *  metricsService 注入完整 mock（启发式/cp-sat/solver 埋点方法齐全）；
 *  candidateEngine 显式传 undefined（保持启发式内联候选路径，避免改变既有求解行为）。
 *
 *  Task A / P0：默认激活阶梯为 OFF（仅 heuristic，CP-SAT 不参与）——与生产缺省一致。
 *  需要走 CP-SAT 路径的测试须通过 configOverride 注入 cpSat.activation（如 'PRODUCTION'/'CANARY'）
 *  或 'SHADOW'，并自行管理 EWOH_SOLVER_ACTIVATION / EWOH_SOLVER_PRODUCTION_ENABLED 环境变量
 *  （env 优先于配置；PRODUCTION 还需 EWOH_SOLVER_PRODUCTION_ENABLED === '1'）。 */
export function makeSolver(
  cpSatConfig?: import('../cp-sat-scheduling-solver').CpSatSolverConfig,
  configOverride?: Partial<import('@shared/api.interface').SchedulingPolicyConfig>,
  extras?: {
    shadowEvaluatorService?: import('../prediction/shadow-evaluator.service').ShadowEvaluatorService;
    outboxService?: import('../outbox.service').OutboxService;
  },
) {
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-TEST' }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue({ ...defaultConfig(), ...configOverride }),
    // P1-C：resolveProfiles 与生产逻辑一致（纯函数，无 DB 依赖）。
    resolveProfiles: SchedulingPolicyService.prototype.resolveProfiles,
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'ROUTE-TEST',
      distanceMeters: 10,
      etaSeconds: 10,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback',
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
    }),
  };
  const metricsService = {
    recordPlanChurn: jest.fn(),
    recordPartialReplanAffected: jest.fn(),
    recordRun: jest.fn(),
    recordFallback: jest.fn(),
    recordSolverTimeout: jest.fn(),
    recordCandidateCount: jest.fn(),
    recordHardReject: jest.fn(),
    recordPolicyEvent: jest.fn(),
  } as unknown as import('../scheduler-metrics.service').SchedulerMetricsService;
  const solver = new SolverService(
    policy as unknown as SchedulingPolicyService,
    routing as unknown as RoutingService,
    routeCostProvider as unknown as RouteCostProvider,
    new EligibilityService(),
    cpSatConfig ?? {
      workerUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
      fetch: jest.fn().mockRejectedValue(new Error('network disabled in unit test')),
    },
    metricsService,
    undefined as unknown as import('../candidate-engine.service').CandidateEngineService,
    extras?.shadowEvaluatorService,
    extras?.outboxService,
  );
  return { solver, routing, policy, routeCostProvider, metricsService };
}

/** 构造一个默认的资格判定上下文。 */
export function makeEligibilityCtx(
  overrides: Partial<EligibilityContext> = {},
): EligibilityContext {
  return {
    now: 0,
    bookedTimeSlots: [],
    bookedDeviceSlots: [],
    bookedStationSlots: [],
    lockedPersonIds: [],
    forbiddenZones: [],
    minBatteryPct: 15,
    maxContinuousLoad: 0.9,
    safetyBlockedPersonIds: [],
    predecessorDone: () => true,
    candidateStartMs: 0,
    candidateEndMs: 0,
    ...overrides,
  };
}