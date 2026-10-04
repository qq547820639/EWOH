/* EVTSC-01（V361）：把"事件不分作用域"钉成**求解器输出层面的行为差分**——V360 记过一条限度：
 * 原有的 4 支位点钉的是引擎两腿差分与接线面，所以「在 heuristic 里按 affectedTaskIds 过滤事件」这种
 * 改法不会让它们红（V360 实测：该变异留在树上跑全量单测 426 套件／3751 例零翻红）。本文件补的就是那把
 * 真闸：同快照跑两遍（有事件／无事件），比每个任务 `decisionTrace.priority.score` 的位移——
 * 现状是两任务同幅位移；任何正确的修法都会让未被圈中的 t2 位移变 0 ⇒ 这里必红。
 */
/// <reference types="jest" />
import { EligibilityService } from '../eligibility.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { buildSnapshot, defaultConfig, defaultPolicy } from './scheduler-test-helpers';
import type { DecisionTrace, SchedulingPlanV2, WorldStateSnapshot } from '@shared/api.interface';

const NOW = 1_700_000_000_000;

function makeSolver(): HeuristicSchedulingSolver {
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

/** 两个可派任务（各配一名人员，避免互相挤掉），事件按 scope 只圈 t1。 */
function snapshot(opts: { severity: string | null }): WorldStateSnapshot {
  const events = opts.severity
    ? [{ eventId: 'evt-1', severity: opts.severity, status: 'open', eventType: 'DEVICE_OFFLINE' }]
    : [];
  const eventImpacts = opts.severity
    ? [{
        eventId: 'evt-1', severity: opts.severity, status: 'open',
        affectedTaskIds: ['t1'], affectedPersonIds: [], affectedDeviceIds: [],
        affectedStationIds: [], affectedZoneIds: [],
      }]
    : [];
  return buildSnapshot({
    persons: ['p1', 'p2'].map((id) => ({
      id, name: id, status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'],
      certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: null, zoneId: null, x: 0, y: 0,
    })),
    tasks: ['t1', 't2'].map((id) => ({
      id, title: id, taskType: 'work', priority: 'medium', status: 'pending',
      assigneeId: null, deviceId: null, stationId: null, zoneId: null,
      planStart: null, planEnd: null, progress: 0, predecessorIds: [],
      requiredSkills: ['work'], requiredCertifications: [],
    })),
    devices: [],
    stations: [],
    events,
    eventImpacts,
  });
}

async function scores(severity: string | null): Promise<Record<string, number>> {
  const solver = makeSolver();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  let plan: SchedulingPlanV2;
  try {
    plan = await solver.solve(snapshot({ severity }), [], {
      planId: 'P', triggerType: 'MANUAL', triggerEntityId: null,
      snapshotVersion: 'WS-TEST-0001', horizonMinutes: 480,
      policy: defaultPolicy(),
    });
  } finally {
    jest.restoreAllMocks();
  }
  const out: Record<string, number> = {};
  for (const a of plan.assignments) {
    const tr = a.decisionTrace as DecisionTrace | undefined;
    expect(tr).toBeDefined();
    out[a.taskId] = Number((tr as unknown as { priority: { score: number } }).priority.score);
  }
  return out;
}

describe('EVTSC-01 求解器输出的事件作用域差分', () => {
  it('EVTSC-01 前提：两个任务都排出去且同快照可复算（否则位移无从比较）', async () => {
    const s = await scores(null);
    expect(Object.keys(s).sort()).toEqual(['t1', 't2']);
    expect(await scores(null)).toEqual(s);
  });

  it('EVTSC-01 现状：只圈 t1 的开放事件，对 t1 与 t2 的紧急度位移同幅（＝不分作用域，改对必红）', async () => {
    const base = await scores(null);
    const risky = await scores('high');
    const d1 = risky.t1 - base.t1;
    const d2 = risky.t2 - base.t2;
    // 负项＝更紧急；两任务同幅位移说明这条事件没按 affectedTaskIds 收窄。
    expect(d1).toBeLessThan(0);
    expect(d2).toBe(d1);
  });

  it('EVTSC-01 反向对照：事件降到非 risky 档 ⇒ 两个位移都归零（证明被量的确实是事件项）', async () => {
    const base = await scores(null);
    const mild = await scores('low');
    expect(mild.t1 - base.t1).toBe(0);
    expect(mild.t2 - base.t2).toBe(0);
  });
});
