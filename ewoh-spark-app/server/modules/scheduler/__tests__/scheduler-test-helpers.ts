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
    status: seed.status ?? 'available',
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
  };
}

export function device(seed: DeviceSeed) {
  return {
    id: seed.id,
    workerName: null,
    deviceModel: null,
    batteryPct: seed.battery ?? 100,
    online: seed.online ?? true,
    status: seed.status ?? 'online',
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

/** 构造 SolverService 所需的最小 mock 依赖，并返回依赖以便测试按需改写。 */
export function makeSolver() {
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-TEST' }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'ROUTE-TEST',
      distanceMeters: 10,
      etaSeconds: 10,
      riskLevel: null,
      feasible: true,
    }),
  };
  const solver = new SolverService(
    policy as unknown as SchedulingPolicyService,
    routing as unknown as RoutingService,
    routeCostProvider as unknown as RouteCostProvider,
    new EligibilityService(),
  );
  return { solver, routing, policy, routeCostProvider };
}

/** 构造一个默认的资格判定上下文。 */
export function makeEligibilityCtx(
  overrides: Partial<EligibilityContext> = {},
): EligibilityContext {
  return {
    now: 0,
    bookedTimeSlots: [],
    lockedPersonIds: [],
    forbiddenZones: [],
    minBatteryPct: 15,
    maxContinuousLoad: 0.9,
    safetyBlockedPersonIds: [],
    predecessorDone: () => true,
    ...overrides,
  };
}