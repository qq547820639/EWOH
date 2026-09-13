/**
 * ADR-056 消费侧回归（2026-09-13）：经验时长模型作为求解器时长输入。
 *
 * 锁定的不变量：
 *  1. **默认 off 逐字节不变**——即使提供者已注入，`predictTaskDuration` 也绝不被调用，
 *     方案与"没有提供者"完全一致（确定性重放的默认护栏）；
 *  2. **advisory + 模型可用** → 无计划窗任务的时间窗用模型时长（有 planStart/planEnd 的
 *     任务仍继承任务级真实事实，不叠加模型）；
 *  3. **advisory 但模型不可用/置信度不足/来源非 ml** → 回退默认时长，方案与 off 模式
 *     **逐字节一致**（"拿不到就不消费"，绝不猜）。
 */
/// <reference types="jest" />
import { EligibilityService } from '../eligibility.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { defaultConfig } from './scheduler-test-helpers';
import type {
  SchedulingPlanV2,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  WorldStateSnapshot,
} from '@shared/api.interface';

const FIXED_NOW = 1_700_000_000_000;
const DEFAULT_DURATION_MS = 1_800_000;
const MODEL_DURATION_MS = 600_000;

function fixturePolicy(): SchedulingPolicy {
  return {
    version: 1,
    latenessWeight: 3,
    walkingWeight: 1,
    workloadBalanceWeight: 1,
    stationWaitWeight: 1,
    changeCostWeight: 1,
    riskWeight: 1,
    energyWeight: 1,
    solverVersion: 'heuristic-v2',
    weights: {
      lateness: 3,
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

/** 模型提供者替身：可配置返回值/是否抛错。 */
function fakeProvider(overrides: {
  result?: { value: number; source: string; confidence: number; modelVersion?: string };
  reject?: boolean;
} = {}): { predictTaskDuration: jest.Mock } {
  return {
    predictTaskDuration: overrides.reject
      ? jest.fn().mockRejectedValue(new Error('model down'))
      : jest.fn().mockResolvedValue(
        overrides.result ?? {
          value: MODEL_DURATION_MS,
          source: 'ml',
          confidence: 0.9,
          modelVersion: 'dm:test-v1',
        },
      ),
    confidenceThreshold: () => 0.5,
  } as unknown as { predictTaskDuration: jest.Mock };
}

function makeSolver(options: {
  configPrediction?: SchedulingPolicyConfig['prediction'];
  provider?: unknown;
}) {
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'ROUTE-DM',
      distanceMeters: 10,
      etaSeconds: 10,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback' as const,
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      fallbackReason: 'no_route_edge' as const,
      dataQuality: 'FRESH' as const,
    }),
  };
  const config: SchedulingPolicyConfig = {
    ...defaultConfig(),
    defaultTaskDurationMs: DEFAULT_DURATION_MS,
    prediction: options.configPrediction,
  };
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue(fixturePolicy()),
    getConfig: jest.fn().mockResolvedValue(config),
  };
  const routing = {
    calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-DM' }),
  };
  // 构造参数顺序见 heuristic 构造函数：provider 是第 10 个（routeMemoStats 之后）。
  const solver = new HeuristicSchedulingSolver(
    policyService as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.provider as never,
  );
  return { solver };
}

function baseSnapshot(): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-DM-1',
    ts: new Date(FIXED_NOW).toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [
      {
        id: 'p1',
        name: 'p1',
        status: 'AVAILABLE',
        healthStatus: 'normal',
        skills: ['work'],
        certifications: [],
        loadLevel: 0,
        fatigueLevel: 0,
        stationId: 'S1',
        zoneId: 'Z1',
        x: 0,
        y: 0,
      },
    ],
    tasks: [
      {
        id: 't1',
        title: '无计划窗任务（默认时长分支）',
        taskType: 'work',
        priority: 'medium',
        status: 'pending_dispatch',
        assigneeId: null,
        deviceId: null,
        stationId: 'S1',
        zoneId: 'Z1',
        planStart: null,
        planEnd: null,
        progress: 0,
        predecessorIds: [],
        requiredSkills: ['work'],
        requiredCertifications: [],
      },
    ],
    devices: [],
    stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 }],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  };
}

function assignmentWindowOf(plan: SchedulingPlanV2): number | null {
  const a = plan.assignments?.[0];
  if (!a?.plannedStart || !a?.plannedEnd) return null;
  return (
    new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()
  );
}

async function solveWith(solver: HeuristicSchedulingSolver): Promise<SchedulingPlanV2> {
  return solver.solve(baseSnapshot(), [], {
    planId: 'P-DM',
    triggerType: 'MANUAL',
    triggerEntityId: null,
    snapshotVersion: 'WS-DM-1',
    horizonMinutes: 480,
  });
}

describe('ADR-056 消费侧：durationModelMode', () => {
  it('默认 off：提供者已注入也**绝不调用**，方案与无提供者一致（逐字节护栏）', async () => {
    const provider = fakeProvider();
    const offWithProvider = makeSolver({ provider }).solver;
    const offWithoutProvider = makeSolver({}).solver;

    const planA = await solveWith(offWithProvider);
    const planB = await solveWith(offWithoutProvider);

    // 提供者一次都没被问（off = 不消费，与是否注入无关）。
    expect(provider.predictTaskDuration).not.toHaveBeenCalled();
    expect(assignmentWindowOf(planA)).toBe(DEFAULT_DURATION_MS);
    expect(assignmentWindowOf(planA)).toBe(assignmentWindowOf(planB));
  });

  it('advisory + 模型可用：无计划窗任务用模型时长', async () => {
    const provider = fakeProvider();
    const solver = makeSolver({
      configPrediction: { durationModelMode: 'advisory' },
      provider,
    }).solver;

    const plan = await solveWith(solver);

    expect(provider.predictTaskDuration).toHaveBeenCalledTimes(1);
    // 无租户 run 传 orgId: undefined（提供者按 ADR-070 对缺 org 显式回退确定性基线）。
    expect(provider.predictTaskDuration).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1' }),
    );
    expect(assignmentWindowOf(plan)).toBe(MODEL_DURATION_MS);
  });

  it('advisory + 来源非 ml（确定性回退）→ 用默认时长（不把"没模型"说成"用了模型"）', async () => {
    const provider = fakeProvider({
      result: { value: MODEL_DURATION_MS, source: 'deterministic', confidence: 0.99 },
    });
    const advisory = makeSolver({
      configPrediction: { durationModelMode: 'advisory' },
      provider,
    }).solver;
    const off = makeSolver({}).solver;

    const planAdvisory = await solveWith(advisory);
    const planOff = await solveWith(off);

    expect(assignmentWindowOf(planAdvisory)).toBe(DEFAULT_DURATION_MS);
    expect(assignmentWindowOf(planAdvisory)).toBe(assignmentWindowOf(planOff));
  });

  it('advisory + 置信度不足 → 回退默认时长', async () => {
    const provider = fakeProvider({
      result: { value: MODEL_DURATION_MS, source: 'ml', confidence: 0.3 },
    });
    const solver = makeSolver({
      configPrediction: { durationModelMode: 'advisory' },
      provider,
    }).solver;

    const plan = await solveWith(solver);
    expect(assignmentWindowOf(plan)).toBe(DEFAULT_DURATION_MS);
  });

  it('advisory + 预测抛错 → 回退默认时长（单任务失败不拖垮 run）', async () => {
    const provider = fakeProvider({ reject: true });
    const solver = makeSolver({
      configPrediction: { durationModelMode: 'advisory' },
      provider,
    }).solver;

    const plan = await solveWith(solver);
    expect(assignmentWindowOf(plan)).toBe(DEFAULT_DURATION_MS);
  });

  it('resolveModelDurations（public）：heuristic 实例可被 CP-SAT 复用同源解析', async () => {
    const provider = fakeProvider();
    const solver = makeSolver({
      configPrediction: { durationModelMode: 'advisory' },
      provider,
    }).solver;
    // public 化后的解析口径：默认 off 之外，advisory 时返回模型映射（供 CP-SAT 同源）。
    const map = await solver.resolveModelDurations(baseSnapshot(), { ...defaultConfig(), defaultTaskDurationMs: DEFAULT_DURATION_MS, prediction: { durationModelMode: 'advisory' } }, DEFAULT_DURATION_MS, null);
    expect(map.get('t1')).toBe(MODEL_DURATION_MS);
    expect(provider.predictTaskDuration).toHaveBeenCalledTimes(1);
  });

  it('advisory + 有计划窗的任务：继承任务级真实事实，不叠加模型', async () => {
    // 任务带 30 分钟计划窗；模型说 10 分钟。窗口语义：planStart/planEnd 是任务级
    // 真实事实（与确定性基线同语义），模型只补"没有事实"的空缺。
    const snapshot = baseSnapshot();
    const task = snapshot.tasks[0] as { planStart: string; planEnd: string };
    task.planStart = new Date(FIXED_NOW).toISOString();
    task.planEnd = new Date(FIXED_NOW + 30 * 60_000).toISOString();

    const provider = fakeProvider();
    const solver = makeSolver({
      configPrediction: { durationModelMode: 'advisory' },
      provider,
    }).solver;

    const plan = await solver.solve(snapshot, [], {
      planId: 'P-DM2',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: 'WS-DM-1',
      horizonMinutes: 480,
    });
    expect(provider.predictTaskDuration).toHaveBeenCalledTimes(1);
    expect(assignmentWindowOf(plan)).toBe(30 * 60_000);
  });
});
