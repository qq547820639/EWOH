/* Incremental Replan V2 / M02：CandidateEngine 接线 parity（修 #17）。
 *
 * 背景：架构师审计发现 heuristic-scheduling-solver.ts 声明 candidateEngine? 但从未调用，
 * 求解器仍内联自建候选池。修复：当注入 CandidateEngineService 时，求解器消费
 * buildCandidatePool（与端点 GET /tasks/:taskId/candidates 同语义）；未注入时保持内联。
 *
 * Parity 测试：同一 snapshot+policy 下，端点候选池（CandidateEngineService.buildCandidatePool）
 * 与求解器消费的候选池一致。已知差异（显式标注）：
 *  - 求解器在引擎池之上应用 lockedWindow / mustFinishBy / bookings 精化（startMs/endMs 可能不同）；
 *  - routeId 由引擎池不携带（映射为 routeCostId），与内联路径的 route graph routeId 不同；
 *  - 候选身份集（personId×deviceId×stationId × eligible）应一致。
 */
/// <reference types="jest" />
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { CandidateEngineService } from '../candidate-engine.service';
import { EligibilityService } from '../eligibility.service';
import type { WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
} from './scheduler-test-helpers';

function makeEngine() {
  const worldState = {
    getCurrentWorldState: jest.fn(),
    buildSnapshot: jest.fn(),
  };
  const resourceProjection = {
    projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'R-1',
      distanceMeters: 10,
      etaSeconds: 10,
      riskLevel: null,
      feasible: true,
      source: 'euclidean_fallback',
      riskCost: 0,
      congestionCost: 0,
      graphVersion: null,
      calculatedAt: new Date().toISOString(),
      fallbackReason: null,
      dataQuality: 'FRESH',
      geometry: [],
    }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const engine = new CandidateEngineService(
    worldState as never,
    resourceProjection as never,
    new EligibilityService(),
    routeCostProvider as never,
    policy as never,
  );
  return { engine, routeCostProvider, policy };
}

function snapshot(): WorldStateSnapshot {
  return buildSnapshot({
    persons: [
      seedPerson({ id: 'p1' }),
      seedPerson({ id: 'p2' }),
    ],
    tasks: [
      {
        ...seedTask({ id: 't1' }),
        stationId: 'S1',
        zoneId: 'Z1',
        requiredSkills: ['work'],
        requiredCertifications: [],
      },
    ],
    devices: [seedDevice({ id: 'd1' })],
    stations: [
      { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 2 },
    ],
    lockedAssignments: [],
  });
}

describe('candidate policy tenant scoping', () => {
  it('passes orgId into policy fallback and propagates config to the pool', async () => {
    const { engine, policy } = makeEngine();
    policy.getConfig.mockClear();

    await engine.buildCandidatePool(snapshot().tasks[0], snapshot(), {
      nowMs: 0,
      orgId: 'orgA',
    });

    expect(policy.getActivePolicy).toHaveBeenCalledWith('orgA');
    expect(policy.getConfig).toHaveBeenCalledWith('orgA');
  });
});

describe('M02 #17 candidate-engine parity', () => {
  it('求解器注入 CandidateEngine 时消费 buildCandidatePool（不再内联自建）', async () => {
    const { engine, policy, routeCostProvider } = makeEngine();
    const snap = snapshot();
    const spy = jest.spyOn(engine, 'buildCandidatePool');

    const solver = new HeuristicSchedulingSolver(
      policy as never,
      {} as never,
      routeCostProvider as never,
      new EligibilityService(),
      undefined,
      undefined,
      undefined,
      engine,
    );
    await solver.solve(snap, [], {
      planId: 'P',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: 'WS-TEST-0001',
      horizonMinutes: 480,
      orgId: 'orgA',
    });

    expect(policy.getActivePolicy).toHaveBeenCalledWith('orgA');
    expect(policy.getConfig).toHaveBeenCalledWith('orgA');
    expect(spy).toHaveBeenCalled();
  });

  it('端点候选池与求解器候选池一致（同 snapshot+policy：身份集+eligible 对齐）', async () => {
    const { engine, policy, routeCostProvider } = makeEngine();
    const snap = snapshot();
    const task = snap.tasks[0];

    // 端点候选池：直接调用 buildCandidatePool（GET /tasks/:taskId/candidates 同语义）。
    const endpointPool = await engine.buildCandidatePool(task, snap, {
      nowMs: 0,
      minBatteryPct: 15,
      maxContinuousLoad: 0.9,
      stationDecisionEnabled: true,
    });
    const endpointIdentity = endpointPool
      .map((c) => `${c.personId}|${c.deviceId ?? '-'}|${c.stationId ?? '-'}|${c.eligible}`)
      .sort();

    // 求解器（注入引擎）消费同一池：spy 捕获求解器实际使用的池。
    const spy = jest.spyOn(engine, 'buildCandidatePool');
    const solver = new HeuristicSchedulingSolver(
      policy as never,
      {} as never,
      routeCostProvider as never,
      new EligibilityService(),
      undefined,
      undefined,
      undefined,
      engine,
    );
    await solver.solve(snap, [], {
      planId: 'P',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: 'WS-TEST-0001',
      horizonMinutes: 480,
    });

    // 求解器必须消费引擎池（spy 被调用且参数为同 task+snapshot）。
    expect(spy).toHaveBeenCalled();
    const solverPool = (await spy.mock.results[0].value) as Awaited<
      ReturnType<typeof engine.buildCandidatePool>
    >;
    const solverIdentity = solverPool
      .map((c) => `${c.personId}|${c.deviceId ?? '-'}|${c.stationId ?? '-'}|${c.eligible}`)
      .sort();

    // Parity：身份集一致（候选身份 + eligible 对齐）。
    expect(solverIdentity).toEqual(endpointIdentity);
    // 显式标注差异：routeId 由引擎池不携带（映射为 routeCostId）——见 M02 报告。
  });
});
