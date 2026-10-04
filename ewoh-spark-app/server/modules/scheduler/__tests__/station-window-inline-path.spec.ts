/* WINCTX-01（V359）：内联候选路径的工位可用窗口判定——补透传之后的常驻位点。
 *
 * 背景（《基线》§5.3nf ③）：`heuristic-scheduling-solver.ts` 的内联候选路径调 `eligibilityService.check`
 * 时没透传 `stationAvailableWindowsById`，而 eligibility 只在 `:462` 读它（空数组＝不限制）⇒ 那条路径上
 * 工位可用窗口恒不生效。该路径生产走不到（候选引擎必选），走它的是 13 份直构 solver 的常驻测试，
 * 且**没有任何一份给 stations 带过 availableWindows**（V359 现算：12 份直构文件里 `availableWindows` 零命中）
 * ⇒ 补透传今天的红面是 0，受益面也是 0：没有测试会因为它改变行为。所以本轮是"补透传＋同时把位点写出来"，
 * 缺任何一半这行都还会是"改了没人验"。
 *
 * 三种取值的真实行为由探针读出（V359，`fix` 在位时）：无窗口数据与窗口覆盖候选时刻都给同一个解；
 * 窗口排除候选时刻 ⇒ 不派工、`violations` 给 `infeasible`。⇒ 补透传是**把内联路径对齐到生产语义**
 * （candidate-engine 路径早就传这个键，`:395/405/529`），不是新发明一套拒绝逻辑。
 */
/// <reference types="jest" />
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { EligibilityService } from '../eligibility.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { buildSnapshot, defaultConfig, defaultPolicy } from './scheduler-test-helpers';
import type { SchedulingPlanV2, WorldStateSnapshot } from '@shared/api.interface';

const NOW = 1_700_000_000_000;

/** 只给 4 个实参＝不给 candidateEngine ⇒ 走 `heuristic-scheduling-solver.ts:1067` 的 else（内联候选路径）。 */
function makeInlineSolver(): HeuristicSchedulingSolver {
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routing = { calculateRoute: jest.fn().mockResolvedValue({ routeId: 'R-1' }) };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'R-1', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
      feasible: true, source: 'euclidean_fallback', riskCost: 0, congestionCost: 0,
      graphVersion: null, calculatedAt: new Date().toISOString(),
      fallbackReason: null, dataQuality: 'FRESH',
    }),
  };
  return new HeuristicSchedulingSolver(
    policyService as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
  );
}

function snapshotWithWindows(
  windows?: Array<{ startMs: number; endMs: number }>,
): WorldStateSnapshot {
  const station: Record<string, unknown> = { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 };
  if (windows !== undefined) station.availableWindows = windows;
  return buildSnapshot({
    persons: [
      {
        id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal',
        skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0,
        stationId: 'S1', zoneId: 'Z1', x: 0, y: 0,
      },
    ],
    tasks: [
      {
        id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
        assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
        planStart: null, planEnd: null, progress: 0, predecessorIds: [],
        requiredSkills: ['work'], requiredCertifications: [],
      },
    ],
    devices: [
      { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE' },
    ],
    stations: [station as never],
  });
}

async function solveWith(
  windows?: Array<{ startMs: number; endMs: number }>,
): Promise<SchedulingPlanV2> {
  const solver = makeInlineSolver();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  try {
    return await solver.solve(snapshotWithWindows(windows), [], {
      planId: 'P', triggerType: 'MANUAL', triggerEntityId: null,
      snapshotVersion: 'WS-TEST-0001', horizonMinutes: 480,
      policy: defaultPolicy(),
    });
  } finally {
    jest.restoreAllMocks();
  }
}

const inlined = (plan: SchedulingPlanV2): string[] =>
  plan.assignments.map((a) => `${a.taskId}@${a.personId}/${a.deviceId}/${a.stationId}`);

describe('WINCTX-01 内联候选路径的工位可用窗口', () => {
  it('WINCTX-01 无窗口数据＝不限制（缺数据不伪造），任务照派', async () => {
    const plan = await solveWith(undefined);
    expect(inlined(plan)).toEqual(['t1@p1/d1/S1']);
    expect(plan.violations ?? []).toEqual([]);
  });

  it('WINCTX-01 窗口覆盖候选时刻时不改变解（与无数据同形）', async () => {
    const plan = await solveWith([{ startMs: NOW - 3_600_000, endMs: NOW + 3_600_000 }]);
    expect(inlined(plan)).toEqual(['t1@p1/d1/S1']);
  });

  it('WINCTX-01 窗口排除候选时刻 ⇒ 不派工并给 infeasible（这条在补透传前必红）', async () => {
    const plan = await solveWith([{ startMs: NOW + 3_600_000, endMs: NOW + 7_200_000 }]);
    expect(plan.assignments).toEqual([]);
    expect((plan.violations ?? []).map((v) => v.type)).toContain('infeasible');
  });

  it('WINCTX-01 接线面：内联那次 check 的 ctx 里确有该键（不是只在 reuse 快路有）', () => {
    const src = readFileSync(resolve(__dirname, '..', 'heuristic-scheduling-solver.ts'), 'utf8');
    const at = src.indexOf('const eligibility = this.eligibilityService.check(');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 2600);
    expect(block).toContain('stationAvailableWindowsById');
    expect(block).toContain('stationCapabilityRecordsById');
  });
});
