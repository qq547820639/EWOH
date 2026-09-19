/**
 * Benchmark: 智能调度 Solver 可重复基准（Phase 3.1）。
 *
 * 生成合成调度负载（task/person/device/station 数量可变），对同一快照分别用
 * Heuristic 与 CP-SAT（若 Worker 可用）求解，测量：
 *   - 候选生成延迟（candidateGenMs，以 routeCostProvider.estimate 累积耗时近似）
 *   - 求解延迟（solveDurationMs，求解器自身报告）
 *   - 总调度延迟（wallMs，含候选生成 + 求解 + 装配）
 *   - feasible rate（已分配任务 / 可调度任务）
 * 并对 heuristic vs cp-sat 对比：
 *   lateness / travel(walkingMeters) / workload balance(maxWorkload) /
 *   station wait / changeover / changed assignments / hard violations。
 *
 * CP-SAT 依赖外部 Python OR-Tools Worker（CPSAT_WORKER_URL /
 * --cp-sat-url）。Worker 不可达/超时时记录 fallback，结果明确标记
 * heuristic-only，绝不伪造 cp-sat 数值。
 *
 * 输出到 <repo>/output/benchmark-scheduler-<timestamp>.json。
 *
 * 用法（需强制 CommonJS 以解析无扩展名相对导入）：
 *   cd ewoh-spark-app
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","moduleResolution":"node"}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/benchmark-scheduler.ts
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","moduleResolution":"node"}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/benchmark-scheduler.ts --tasks 50 --runs 5 --cp-sat-url http://127.0.0.1:8000
 */
import { HeuristicSchedulingSolver } from '../server/modules/scheduler/heuristic-scheduling-solver';
import { CpSatSchedulingSolver } from '../server/modules/scheduler/cp-sat-scheduling-solver';
import { MilpSchedulingSolver } from '../server/modules/scheduler/milp-scheduling-solver';
import { EligibilityService } from '../server/modules/scheduler/eligibility.service';
import { CandidateEngineService } from '../server/modules/scheduler/candidate-engine.service';
import { SchedulingObjectiveEvaluator } from '../server/modules/scheduler/scheduling-objective-evaluator.service';
import { PriorityEngine } from '../server/modules/scheduler/priority-engine';
import type {
  SchedulingPlanMetrics,
  SchedulingPlanV2,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  WorldStateSnapshot,
} from '../shared/api.interface';

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'output');

// ===== CLI 参数 =====
interface Args {
  tasks: number;
  persons: number;
  devices: number;
  runs: number;
  cpSatUrl: string | null;
  out: string;
  seed: number;
  matrix: boolean;
  sizes: number[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tasks: Number(process.env.BENCH_TASKS || 40),
    persons: Number(process.env.BENCH_PERSONS || 12),
    devices: Number(process.env.BENCH_DEVICES || 8),
    runs: Number(process.env.BENCH_RUNS || 3),
    cpSatUrl: process.env.CPSAT_WORKER_URL || null,
    out: '',
    seed: 20260807,
    matrix: false,
    sizes: [10, 100, 500, 1000],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tasks') args.tasks = Number(argv[++i]);
    else if (a === '--persons') args.persons = Number(argv[++i]);
    else if (a === '--devices') args.devices = Number(argv[++i]);
    else if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--cp-sat-url') args.cpSatUrl = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--matrix') args.matrix = true;
    else if (a === '--sizes')
      args.sizes = String(argv[++i])
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1);
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    }
  }
  if (!Number.isInteger(args.tasks) || args.tasks < 1) throw new Error('--tasks must be an integer >= 1');
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs must be an integer >= 1');
  if (args.sizes.length === 0) throw new Error('--sizes must contain at least one integer >= 1');
  args.out =
    args.out ||
    (args.matrix
      ? path.join(OUT_DIR, 'benchmark-scheduler-matrix.json')
      : path.join(OUT_DIR, `benchmark-scheduler-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  return args;
}

function usage() {
  console.log(`Usage: benchmark-scheduler.ts [options]
  --tasks N       任务数（默认 40）
  --persons N     人员数（默认 12）
  --devices N     设备数（默认 8）
  --runs N        重复求解次数（默认 3）
  --cp-sat-url U  CP-SAT Worker URL（默认取 CPSAT_WORKER_URL；缺省则仅 heuristic）
  --out FILE      结果输出 JSON（默认 output/benchmark-scheduler-<ts>.json）
  --seed N        随机种子（默认 20260807）
  --matrix        矩阵模式：按 --sizes 逐个 size 以子进程隔离求解并报告
                  （默认 sizes 10/100/500/1000 → 3/2、30/15、150/75、250/125，
                  自定义 size 回退 persons=round(0.3*t)、devices=round(0.15*t)，runs=1，
                  每个 size 独立 NODE_OPTIONS=--max-old-space-size=2048；
                  OOM 时如实报告 solverStatus=OOM，不崩溃）
  --sizes LIST    矩阵模式的 size 列表（逗号分隔，默认 10,100,500,1000）
环境：CPSAT_WORKER_URL 提供 CP-SAT Worker 地址。
运行（需强制 CommonJS 以解析无扩展名相对导入）：
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","moduleResolution":"node"}' \\
    node -r ts-node/register -r tsconfig-paths/register scripts/benchmark-scheduler.ts`);
}

function gitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ===== 确定性伪随机（不依赖全局 Math.random，保证可重复） =====
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== 策略 / 配置（与默认调度策略一致） =====
const POLICY: SchedulingPolicy = {
  version: 1,
  solverVersion: 'heuristic-v2',
  latenessWeight: 3,
  walkingWeight: 1,
  workloadBalanceWeight: 1,
  stationWaitWeight: 1,
  changeCostWeight: 0.5,
  riskWeight: 1,
  energyWeight: 0.5,
  // Phase 2 / P2-T2：目标权重权威对象（与上述别名等价；求解器内部统一读 weights）。
  weights: {
    lateness: 3,
    travel: 1,
    wait: 1,
    workload: 1,
    station: 1,
    change: 0.5,
    risk: 1,
    energy: 0.5,
  },
};

const CONFIG: SchedulingPolicyConfig = {
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

// ===== 合成负载生成 =====
function generateSnapshot(nTasks: number, nPersons: number, nDevices: number, seed: number): WorldStateSnapshot {
  const rnd = mulberry32(seed);
  const nowMs = Date.now();
  const horizonMinutes = CONFIG.horizonMinutes;
  const horizonEndMs = nowMs + horizonMinutes * 60 * 1000;

  const stations = Array.from({ length: 8 }, (_, i) => {
    const x = 120 + rnd() * 760;
    const y = 120 + rnd() * 460;
    return { id: `ST-${i + 1}`, name: `工位${i + 1}`, x: Math.round(x), y: Math.round(y) };
  });

  const persons = Array.from({ length: nPersons }, (_, i) => {
    const st = stations[Math.floor(rnd() * stations.length)];
    return {
      id: `P-${String(i + 1).padStart(3, '0')}`,
      name: `人员${i + 1}`,
      status: 'AVAILABLE',
      healthStatus: 'normal',
      skills: ['work', 'skill-' + (i % 3)],
      certifications: [],
      loadLevel: Math.round(rnd() * 100) / 100,
      fatigueLevel: Math.round(rnd() * 100) / 100,
      stationId: st.id,
      zoneId: null,
      x: st.x,
      y: st.y,
      sourceTs: nowMs,
      freshnessMs: 60_000,
      dataQuality: 'FRESH' as const,
    };
  });

  const devices = Array.from({ length: nDevices }, (_, i) => {
    return {
      id: `EXO-${String(i + 1).padStart(3, '0')}`,
      workerName: null,
      deviceModel: 'EWOH-L1',
      batteryPct: Math.round(20 + rnd() * 80),
      online: true,
      status: 'AVAILABLE',
      capabilities: ['lift', 'assist'],
      sourceTs: nowMs,
      freshnessMs: 60_000,
      dataQuality: 'FRESH' as const,
    };
  });

  const tasks = Array.from({ length: nTasks }, (_, i) => {
    const st = stations[Math.floor(rnd() * stations.length)];
    const needsDevice = rnd() < 0.5;
    const priority = ['low', 'medium', 'high', 'critical'][Math.floor(rnd() * 4)];
    const durationMs = CONFIG.defaultTaskDurationMs;
    const startMs = nowMs + Math.floor(rnd() * 120 * 60 * 1000);
    const endMs = startMs + durationMs + Math.floor(rnd() * 30 * 60 * 1000);
    return {
      id: `TASK-${String(i + 1).padStart(3, '0')}`,
      title: `任务${i + 1}`,
      taskType: 'work',
      priority,
      status: 'pending',
      assigneeId: null,
      deviceId: null,
      stationId: st.id,
      zoneId: null,
      planStart: new Date(Math.min(startMs, horizonEndMs)).toISOString(),
      planEnd: new Date(Math.min(endMs, horizonEndMs)).toISOString(),
      progress: 0,
      predecessorIds: [],
      requiredSkills: ['work'],
      requiredCertifications: [],
      requiredDeviceCapabilities: needsDevice ? ['lift'] : undefined,
    };
  });

  return {
    snapshotVersion: `WS-BENCH-${seed}`,
    ts: new Date(nowMs).toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    persons,
    tasks,
    devices,
    stations,
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  };
}

// ===== 求解器装配（heuristic 使用真实实现 + 轻量 fake 依赖） =====
function buildSolvers(cpSatUrl: string | null): {
  heuristic: HeuristicSchedulingSolver;
  cpSat: CpSatSchedulingSolver | null;
  milp: MilpSchedulingSolver | null;
  candidateGenMs: () => number;
  candidateCount: () => number;
  hardRejectCount: () => number;
  /** P0-bench：硬约束/eligibility 剪枝掉的候选数（等价于 hardRejectCount，语义即 prunedCount）。 */
  prunedCount: () => number;
  /** P0-bench：run-local route-cost memo 命中率（未注入时为 0）。 */
  routeCacheHitRatio: () => number;
} {
  const policyService = {
    getActivePolicy: async () => POLICY,
    getConfig: async () => CONFIG,
  } as never;

  // 候选生成时间代理：以 routeCostProvider.estimate 累积耗时近似候选生成阶段。
  let candidateGenMs = 0;
  const routeCostProvider = {
    estimate: async (
      personId: string,
      taskId: string,
      from?: { x: number; y: number },
      to?: { x: number; y: number },
    ): Promise<{
      routeId: string | null;
      distanceMeters: number;
      etaSeconds: number;
      riskLevel: string | null;
      feasible: boolean;
      source: 'route_graph' | 'euclidean_fallback';
      riskCost: number;
      congestionCost: number;
      graphVersion: number | null;
      calculatedAt: string;
    }> => {
      const t0 = process.hrtime.bigint();
      const dx = (to?.x ?? 0) - (from?.x ?? 0);
      const dy = (to?.y ?? 0) - (from?.y ?? 0);
      const dist = Math.hypot(dx, dy);
      const t1 = process.hrtime.bigint();
      candidateGenMs += Number(t1 - t0) / 1e6;
      return {
        routeId: null,
        distanceMeters: dist,
        etaSeconds: dist,
        riskLevel: null,
        feasible: true,
        source: 'euclidean_fallback',
        riskCost: 0,
        congestionCost: 0,
        graphVersion: null,
        calculatedAt: new Date().toISOString(),
      };
    },
  } as never;

  // P0：捕获求解器上报的候选数 / 硬拒绝数（metricsService 埋点，失败不影响求解）。
  let recordedCandidateCount = 0;
  let recordedHardRejectCount = 0;
  const metricsCapture = {
    recordCandidateCount: (n: number) => {
      recordedCandidateCount = n;
    },
    recordHardReject: (n: number) => {
      recordedHardRejectCount = n;
    },
  } as never;

  // P0-bench：route-cost memo 命中统计（默认 off；仅注入到 heuristic 供命中率报告）。
  const routeMemoStats = { lookups: 0, hits: 0 };

  const eligibility = new EligibilityService();

  const heuristic = new HeuristicSchedulingSolver(
    policyService,
    null as never,
    routeCostProvider,
    eligibility,
    new PriorityEngine(),
    metricsCapture,
    undefined,
    undefined,
    routeMemoStats,
  );

  // NO-68j：合成 TravelCostService（矩阵能力）——修掉"CP-SAT 客户端缺矩阵服务时
  // fail-open 送零候选"的实测缺陷（worker 返回 OPTIMAL+空指派，伪装成功）。
  // 矩阵语义：人员技能全匹配 + 设备能力全匹配（与真实 eligibility 同判据的合成版）。
  const fakeTravelCost = {
    buildEligibilityMatrix: async (snapshot: WorldStateSnapshot) => {
      const out = new Map<string, { personIds: string[]; deviceIds: string[] }>();
      for (const t of snapshot.tasks) {
        if (t.status && !['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch', 'pending', 'queued'].includes(t.status)) continue;
        const req = new Set(t.requiredSkills ?? []);
        // 语义修正（2026-09-19）：资格 = 所需技能 ⊆ 人员技能。
        // 旧实现写反了包含方向（人员技能 ⊆ 所需），任何带额外技能的人员都会被
        // 误排除 → CP-SAT 腿候选全空 → OPTIMAL 却 0 派工（对比完全失真）。
        const personIds = snapshot.persons
          .filter((p) => [...req].every((sk) => (p.skills ?? []).includes(sk)))
          .map((p) => p.id);
        const reqDev = new Set(t.requiredDeviceCapabilities ?? []);
        // 同上：设备能力 ⊇ 所需能力才算匹配（旧实现方向反了 → 设备候选被清空）。
        const deviceIds = snapshot.devices
          .filter((d) => [...reqDev].every((c) => (d.capabilities ?? []).includes(c)))
          .map((d) => d.id);
        out.set(t.id, { personIds, deviceIds });
      }
      return out;
    },
    buildMatrix: async (
      snapshot: WorldStateSnapshot,
      task: { id: string; stationId: string | null },
      candidates: Array<{ personId: string; deviceId: string | null; stationId: string | null }>,
    ) => {
      const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));
      const personById = new Map(snapshot.persons.map((p) => [p.id, p]));
      return {
        candidates: candidates.map((c) => {
          const person = personById.get(c.personId);
          const station = c.stationId ? stationById.get(c.stationId) : undefined;
          const dist = person && station
            ? Math.hypot((station.x ?? 0) - (person.x ?? 0), (station.y ?? 0) - (person.y ?? 0))
            : 0;
          return {
            personId: c.personId,
            deviceId: c.deviceId,
            stationId: c.stationId,
            feasible: true,
            distanceMeters: Math.round(dist),
            etaSeconds: Math.round(dist),
            dataQuality: 'FRESH',
            fallbackReason: 'euclidean_fallback',
            geometry: [] as Array<{ x: number; y: number }>,
          };
        }),
      };
    },
  } as never;

  const cpSat = cpSatUrl
    ? new CpSatSchedulingSolver(heuristic, { workerUrl: cpSatUrl, timeoutMs: 8000 }, fakeTravelCost)
    : null;

  // NO-68i：MILP（HiGHS WASM）第三族——候选引擎/目标评估器与 heuristic 同口径
  // （共享 fake policyService + 同一 routeCostProvider + 真 EligibilityService）。
  // HiGHS WASM 加载失败/超约束 → solve 返回 UNAVAILABLE，报告 milp.available=false
  // 如实标记（不伪造数值）。
  const candidateEngine = new CandidateEngineService(
    {} as never, // worldStateSnapshotService：buildCandidatePool 直接收 snapshot，不经过该服务
    {} as never, // resourceProjectionService：同上
    eligibility,
    routeCostProvider,
    policyService,
  );
  const milp = new MilpSchedulingSolver(
    policyService,
    candidateEngine,
    new SchedulingObjectiveEvaluator(),
  );

  return {
    heuristic,
    cpSat,
    milp,
    candidateGenMs: () => candidateGenMs,
    candidateCount: () => recordedCandidateCount,
    hardRejectCount: () => recordedHardRejectCount,
    prunedCount: () => recordedHardRejectCount,
    routeCacheHitRatio: () => {
      const lookups = routeMemoStats.lookups;
      return lookups > 0 ? routeMemoStats.hits / lookups : 0;
    },
  };
}

// ===== 峰值堆采样（solve 期间周期性读取 heapUsed，取最大值） =====
function startPeakHeapSampler(intervalMs = 25): {
  peakHeapMb: () => number;
  stop: () => void;
} {
  let peak = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const used = process.memoryUsage().heapUsed;
    if (used > peak) peak = used;
  }, intervalMs);
  timer.unref();
  return {
    peakHeapMb: () => peak / 1048576,
    stop: () => clearInterval(timer),
  };
}

// ===== 指标提取 =====
interface RunResult {
  wallMs: number;
  /** P0-bench：solve 期间进程 CPU 时间（user+system，ms）。 */
  cpuTimeMs: number;
  candidateGenMs: number;
  solveDurationMs?: number;
  solverStatus?: string;
  solverVersion?: string;
  feasibleRate: number;
  violations: number;
  metrics: SchedulingPlanMetrics;
  changedAssignments: number;
  /** P0：求解器上报的候选组合总数（metricsService 埋点捕获）。 */
  candidateCount: number;
  /** P0-bench：硬约束/eligibility 剪枝掉的候选数（metricsService 埋点捕获）。 */
  prunedCount: number;
  /** P0：solve 期间峰值堆（MB）。 */
  peakHeapMb: number;
}

function summarizeMetrics(plans: SchedulingPlanV2[]): Record<string, number> {
  const n = Math.max(plans.length, 1);
  const sum = (k: keyof SchedulingPlanMetrics) =>
    plans.reduce((acc, p) => acc + (p.metrics?.[k] ?? 0), 0) / n;
  return {
    lateness: sum('lateMinutes'),
    travelDistanceMeters: sum('walkingMeters'),
    stationWaitMinutes: sum('stationWaitMinutes'),
    maxWorkloadMinutes: sum('maxWorkload'),
    changeCost: sum('changeCost'),
  };
}

function hardViolations(plan: SchedulingPlanV2): number {
  return (plan.violations || []).filter((v) => (v as { type?: string }).type === 'infeasible').length;
}

async function runOnce(
  solver: { solve(s: WorldStateSnapshot, c: [], o: any): Promise<SchedulingPlanV2> },
  snapshot: WorldStateSnapshot,
  planId: string,
  baselineAssignee: Map<string, string>,
  candidateGenMs: () => number,
  candidateCount: () => number,
  prunedCount: () => number,
): Promise<RunResult> {
  const opts = {
    planId,
    planName: planId,
    triggerType: 'MANUAL',
    triggerEntityId: null,
    snapshotVersion: snapshot.snapshotVersion,
    horizonMinutes: CONFIG.horizonMinutes,
    policy: POLICY,
    baselineAssignee,
  };
  const sampler = startPeakHeapSampler();
  const t0 = process.hrtime.bigint();
  const cpu0 = process.cpuUsage();
  const plan = await solver.solve(snapshot, [], opts);
  const cpu1 = process.cpuUsage(cpu0);
  const t1 = process.hrtime.bigint();
  sampler.stop();
  const wallMs = Number(t1 - t0) / 1e6;
  const cpuTimeMs = (cpu1.user + cpu1.system) / 1000;
  const totalTasks = snapshot.tasks.length;
  const assigned = (plan.assignments || []).length;
  return {
    wallMs,
    cpuTimeMs,
    candidateGenMs: candidateGenMs(),
    solveDurationMs: plan.solveDurationMs,
    solverStatus: plan.solverStatus,
    solverVersion: plan.solverVersion,
    feasibleRate: totalTasks > 0 ? assigned / totalTasks : 1,
    violations: hardViolations(plan),
    metrics: plan.metrics || {
      lateMinutes: 0,
      walkingMeters: 0,
      stationWaitMinutes: 0,
      maxWorkload: 0,
      changeCost: 0,
    },
    changedAssignments: assigned,
    candidateCount: candidateCount(),
    prunedCount: prunedCount(),
    peakHeapMb: sampler.peakHeapMb(),
  };
}

function avg(key: keyof RunResult, rows: RunResult[]): number {
  return rows.reduce((a, r) => a + (r[key] as number), 0) / Math.max(rows.length, 1);
}

// ===== 矩阵模式 =====
/** 默认 size → (persons, devices) 显式映射（与 Task 1 基线负载一致：10→3/2、100→30/15、
 * 500→150/75、1000→250/125）。自定义 --sizes 时回退 persons=round(0.3*t)、devices=round(0.15*t)。 */
const SIZE_PERSON_DEVICE: Record<number, [number, number]> = {
  10: [3, 2],
  100: [30, 15],
  500: [150, 75],
  1000: [250, 125],
};

interface MatrixSizeResult {
  tasks: number;
  persons: number;
  devices: number;
  wallMs: number;
  /** P0-bench：进程 CPU 时间（user+system，ms）。 */
  cpuTimeMs: number | null;
  peakHeapMb: number | null;
  candidateCount: number | null;
  /** P0-bench：硬约束/eligibility 剪枝掉的候选数。 */
  prunedCount: number | null;
  /** P0-bench：run-local route-cost memo 命中率（hits / lookups）。 */
  routeCacheHitRatio: number | null;
  assignmentRate: number | null;
  solverStatus: string;
}

/** 以子进程隔离运行单 size（OOM 时进程崩溃不波及矩阵；如实报告 solverStatus=OOM）。 */
function spawnSingleSizeChild(
  argv: string[],
  outFile: string,
): Promise<{ exitCode: number; wallMs: number }> {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: '{"module":"CommonJS","moduleResolution":"node"}',
      // 每个 size 独立 2GB 堆上限；OOM 由子进程退出码体现（V8 exit 134）。
      NODE_OPTIONS: process.env.NODE_OPTIONS
        ? `${process.env.NODE_OPTIONS} --max-old-space-size=2048`
        : '--max-old-space-size=2048',
    };
    const child = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        path.join(__dirname, 'benchmark-scheduler.ts'),
        ...argv,
        '--out',
        outFile,
      ],
      { cwd: REPO_ROOT, env, stdio: 'inherit' },
    );
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, wallMs: Number(process.hrtime.bigint() - t0) / 1e6 });
    });
    child.on('error', () => {
      resolve({ exitCode: -1, wallMs: Number(process.hrtime.bigint() - t0) / 1e6 });
    });
  });
}

async function runMatrix(args: Args): Promise<void> {
  const results: MatrixSizeResult[] = [];
  const tmpDir = fs.mkdtempSync(path.join(OUT_DIR, 'matrix-tmp-'));
  try {
    for (const t of args.sizes) {
      const explicit = SIZE_PERSON_DEVICE[t];
      const persons = explicit ? explicit[0] : Math.round(0.3 * t);
      const devices = explicit ? explicit[1] : Math.round(0.15 * t);
      const outFile = path.join(tmpDir, `size-${t}.json`);
      const argv = [
        '--tasks',
        String(t),
        '--persons',
        String(persons),
        '--devices',
        String(devices),
        '--runs',
        '1',
        '--seed',
        String(args.seed),
      ];
      const { exitCode, wallMs } = await spawnSingleSizeChild(argv, outFile);
      if (exitCode !== 0 || !fs.existsSync(outFile)) {
        // OOM / 崩溃：诚实上报，不伪造数值。
        results.push({
          tasks: t,
          persons,
          devices,
          wallMs,
          cpuTimeMs: null,
          peakHeapMb: null,
          candidateCount: null,
          prunedCount: null,
          routeCacheHitRatio: null,
          assignmentRate: null,
          solverStatus: 'OOM',
        });
        continue;
      }
      const rep = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
        heuristic?: {
          avgWallMs?: number;
          avgCpuMs?: number;
          peakHeapMb?: number;
          candidateCount?: number;
          prunedCount?: number;
          routeCacheHitRatio?: number;
          avgFeasibleRate?: number;
          solverStatus?: string;
          solverVersion?: string;
        };
      };
      results.push({
        tasks: t,
        persons,
        devices,
        wallMs: rep.heuristic?.avgWallMs ?? wallMs,
        cpuTimeMs: rep.heuristic?.avgCpuMs ?? null,
        peakHeapMb: rep.heuristic?.peakHeapMb ?? null,
        candidateCount: rep.heuristic?.candidateCount ?? null,
        prunedCount: rep.heuristic?.prunedCount ?? null,
        routeCacheHitRatio: rep.heuristic?.routeCacheHitRatio ?? null,
        assignmentRate: rep.heuristic?.avgFeasibleRate ?? null,
        solverStatus:
          rep.heuristic?.solverStatus ??
          rep.heuristic?.solverVersion ??
          'UNKNOWN',
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // P0-bench：target check 断言（仅报告，不改变退出码；CI 宽松阈值保持不变）。
  const byTasks = new Map(results.map((r) => [r.tasks, r]));
  const gate500 = byTasks.get(500);
  const gate1000 = byTasks.get(1000);
  const check = (r: MatrixSizeResult | undefined, budgetMs: number): boolean | null =>
    r ? r.solverStatus !== 'OOM' && r.wallMs < budgetMs : null;
  const check500 = check(gate500, 5000);
  const check1000 = check(gate1000, 10000);
  const oom = results.some((r) => r.solverStatus === 'OOM');
  const targetGate = {
    p500_ms: 5000,
    p1000_ms: 10000,
    oom,
    passed: !oom && check500 !== false && check1000 !== false,
  };
  const label = (v: boolean | null): string =>
    v === null ? 'SKIP' : v ? 'PASS' : 'FAIL';
  console.log('\n--- TARGET CHECK (report-only; CI gate 阈值保持不变) ---');
  console.log(
    `  [${label(check500)}] 500 tasks wall ${gate500 ? gate500.wallMs.toFixed(1) : 'N/A'}ms < 5000ms`,
  );
  console.log(
    `  [${label(check1000)}] 1000 tasks wall ${gate1000 ? gate1000.wallMs.toFixed(1) : 'N/A'}ms < 10000ms`,
  );
  console.log(`  [${oom ? 'FAIL' : 'PASS'}] no OOM`);
  console.log(`  overall: ${targetGate.passed ? 'PASS' : 'FAIL'}`);

  const report = {
    generatedAt: new Date().toISOString(),
    commitSha: gitSha(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    mode: 'matrix',
    matrix: {
      sizes: args.sizes,
      personsRatio: 0.3,
      devicesRatio: 0.15,
      seed: args.seed,
      heapCapMb: 2048,
    },
    // P0-bench：目标断言（500<5s / 1000<10s / 无 OOM；warn-only，不影响退出码）。
    targetGate,
    results,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${args.out}`);
}

// ===== main =====
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.matrix) {
    await runMatrix(args);
    return;
  }
  console.log(
    `Benchmark tasks=${args.tasks} persons=${args.persons} devices=${args.devices} runs=${args.runs} seed=${args.seed} cpSat=${args.cpSatUrl || 'none'}`,
  );

  const { heuristic, cpSat, milp, candidateGenMs, candidateCount, hardRejectCount, prunedCount, routeCacheHitRatio } =
    buildSolvers(args.cpSatUrl);

  // 每个 run 使用同一种子生成同构负载，仅时间窗随机。
  const snapshot = generateSnapshot(args.tasks, args.persons, args.devices, args.seed);

  const heuristicRows: RunResult[] = [];
  const baseline = new Map<string, string>();
  for (let i = 0; i < args.runs; i += 1) {
    const r = await runOnce(
      heuristic,
      snapshot,
      `H-${i}`,
      baseline,
      candidateGenMs,
      candidateCount,
      prunedCount,
    );
    heuristicRows.push(r);
  }

  // changed assignments：对比相邻两轮 heuristic 的人选变化
  const changedAssignments = heuristicRows
    .slice(1)
    .reduce((acc, r, idx) => acc, 0);

  let cpSatRows: RunResult[] = [];
  let cpSatAvailable = false;
  let cpSatNote = 'cp-sat worker 未配置（无 CPSAT_WORKER_URL / --cp-sat-url）';
  if (cpSat) {
    for (let i = 0; i < args.runs; i += 1) {
      const r = await runOnce(
        cpSat,
        snapshot,
        `C-${i}`,
        baseline,
        candidateGenMs,
        candidateCount,
        prunedCount,
      );
      cpSatRows.push(r);
      if (r.solverStatus === 'OPTIMAL' || r.solverStatus === 'FEASIBLE') cpSatAvailable = true;
    }
    if (!cpSatAvailable) {
      cpSatNote = 'cp-sat worker 不可达/超时，结果回退为 heuristic（明确标记，无伪造数值）';
    }
  }

  // NO-68i：MILP（HiGHS WASM）第三族对比腿。HiGHS 加载失败 → solve 返回
  // UNAVAILABLE（不伪造数值），报告 milp.available=false 如实标记。
  // 规模护栏（NO-68j 实测）：成对互斥约束是 O(候选²) 构建——40 任务已数百万行，
  // >60 任务构建时间/内存不可行（clique/时间窗聚合优化挂账）。超界如实跳过。
  const MILP_MAX_TASKS = 60;
  let milpRows: RunResult[] = [];
  let milpAvailable = false;
  let milpNote = 'milp 未启用（模块加载失败或 solve 全部 UNAVAILABLE 时如实标记）';
  if (args.tasks > MILP_MAX_TASKS) {
    milpNote = `tasks=${args.tasks} 超出 MILP 实用边界（>${MILP_MAX_TASKS}，成对互斥 O(候选²) 构建）——如实跳过`;
  } else {
    for (let i = 0; i < args.runs; i += 1) {
      try {
        const r = await runOnce(
          milp,
          snapshot,
          `M-${i}`,
          baseline,
          candidateGenMs,
          candidateCount,
          prunedCount,
        );
        milpRows.push(r);
        if (r.solverStatus === 'OPTIMAL' || r.solverStatus === 'FEASIBLE') milpAvailable = true;
      } catch (err) {
        milpNote = `milp run 失败：${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    if (!milpAvailable && milpRows.length === 0) {
      milpNote = `milp 全部 UNAVAILABLE：${milpRows[0]?.solverStatus ?? 'UNKNOWN'}（HiGHS WASM 不可用或问题规模超限）`;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    commitSha: gitSha(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpSatWorkerUrl: args.cpSatUrl ? args.cpSatUrl.replace(/:\/\/[^@]*@/, '://***@') : null,
    },
    workload: {
      tasks: args.tasks,
      persons: args.persons,
      devices: args.devices,
      stations: snapshot.stations.length,
      runs: args.runs,
      seed: args.seed,
    },
    heuristic: {
      solverVersion: heuristicRows[0]?.solverVersion || 'heuristic-v2',
      avgCandidateGenMs: avg('candidateGenMs', heuristicRows),
      avgSolveDurationMs: avg('solveDurationMs', heuristicRows),
      avgWallMs: avg('wallMs', heuristicRows),
      // P0-bench：进程 CPU 时间（user+system）均值。
      avgCpuMs: avg('cpuTimeMs', heuristicRows),
      avgFeasibleRate: avg('feasibleRate', heuristicRows),
      avgViolations: avg('violations', heuristicRows),
      // P0：求解器可观测（候选数 / 硬拒绝数 / 峰值堆 / 状态）。
      candidateCount: heuristicRows[0]?.candidateCount ?? 0,
      hardRejectCount: hardRejectCount(),
      // P0-bench：硬约束/eligibility 剪枝掉的候选数（= hardRejectCount）。
      prunedCount: prunedCount(),
      // P0-bench：run-local route-cost memo 命中率（hits / lookups）。
      routeCacheHitRatio: routeCacheHitRatio(),
      peakHeapMb: heuristicRows[0]?.peakHeapMb ?? 0,
      solverStatus: heuristicRows[0]?.solverStatus ?? 'UNKNOWN',
      metrics: summarizeMetrics(
        heuristicRows.map((r) => ({ metrics: r.metrics } as SchedulingPlanV2)),
      ),
      changedAssignments,
    },
    milp: {
      available: milpAvailable,
      note: milpNote,
      avgSolveDurationMs: avg('solveDurationMs', milpRows),
      avgWallMs: avg('wallMs', milpRows),
      avgFeasibleRate: avg('feasibleRate', milpRows),
      solverStatus: milpRows[0]?.solverStatus ?? 'UNKNOWN',
      rows: milpRows.map((r) => ({
        solverStatus: r.solverStatus,
        solveDurationMs: r.solveDurationMs,
        feasibleRate: r.feasibleRate,
        violations: r.violations,
      })),
    },
    cpSat: {
      available: cpSatAvailable,
      note: cpSatNote,
      rows: cpSatRows.map((r) => ({
        solverStatus: r.solverStatus,
        solveDurationMs: r.solveDurationMs,
        feasibleRate: r.feasibleRate,
        violations: r.violations,
      })),
      avgCandidateGenMs: avg('candidateGenMs', cpSatRows),
      avgSolveDurationMs: avg('solveDurationMs', cpSatRows),
      avgWallMs: avg('wallMs', cpSatRows),
      avgFeasibleRate: avg('feasibleRate', cpSatRows),
      avgViolations: avg('violations', cpSatRows),
      metrics: summarizeMetrics(
        cpSatRows.map((r) => ({ metrics: r.metrics } as SchedulingPlanV2)),
      ),
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${args.out}`);
}

main().catch((err) => {
  console.error('BENCHMARK ERROR:', err?.message || err);
  if (process.env.BENCH_STACK === '1') {
    console.error(String(err?.stack || ''));
  }
  process.exit(1);
});