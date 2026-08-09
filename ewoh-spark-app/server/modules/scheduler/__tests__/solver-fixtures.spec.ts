/* Phase 2 / P2-T3：固定 fixtures 确定性重放测试。
 *
 * 从 __fixtures__/*.json 读取统一 JSON schema（snapshot + policy + weights +
 * solverVersion），构造 HeuristicSchedulingSolver（纯确定性，无 CP-SAT 网络依赖），
 * 对每个 fixture：
 *   1. 两次求解（固定 Date.now）→ 结构完全一致（确定性重放）；
 *   2. solverStatus=HEURISTIC、objective 两次相等且非负；
 *   3. 按 fixture.expected 断言 assignment / unassigned / frozen / 顺序 / 不重叠等。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import { EligibilityService } from '../eligibility.service';
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { defaultConfig } from './scheduler-test-helpers';
import type {
  ObjectiveWeights,
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  WorldStateSnapshot,
} from '@shared/api.interface';

const FIXED_NOW = 1_700_000_000_000;
const FIXTURES_DIR = path.join(__dirname, '..', '__fixtures__');

interface FixtureFile {
  name: string;
  description?: string;
  solverVersion: string;
  weights: ObjectiveWeights;
  snapshot: {
    snapshotVersion: string;
    persons?: Array<Record<string, unknown>>;
    tasks?: Array<Record<string, unknown>>;
    devices?: Array<Record<string, unknown>>;
    stations?: Array<Record<string, unknown>>;
    forbiddenZones?: Array<Record<string, unknown>>;
    routeStatus?: Array<Record<string, unknown>>;
    lockedAssignments?: Array<Record<string, unknown>>;
    safetyBlockedPersonIds?: string[];
  };
  expected: {
    assignedTaskIds?: string[];
    unassignedTaskIds?: string[];
    assignedPersonId?: string;
    manualDevice?: boolean;
    predecessorOrder?: boolean;
    noOverlap?: boolean;
    frozenTaskId?: string;
    excludedTaskId?: string;
    violation?: string;
    routeInfeasible?: boolean;
    minBatteryConstraint?: { type: string; value: number };
  };
}

function loadFixtures(): FixtureFile[] {
  const files = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) =>
    JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')),
  );
}

function buildSnapshot(fix: FixtureFile): WorldStateSnapshot {
  return {
    snapshotVersion: fix.snapshot.snapshotVersion ?? 'WS-FIXTURE',
    ts: new Date(FIXED_NOW).toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: (fix.snapshot.persons ?? []) as WorldStateSnapshot['persons'],
    tasks: (fix.snapshot.tasks ?? []) as WorldStateSnapshot['tasks'],
    devices: (fix.snapshot.devices ?? []) as WorldStateSnapshot['devices'],
    stations: (fix.snapshot.stations ?? []) as WorldStateSnapshot['stations'],
    backlog: [],
    events: [],
    routeStatus: (fix.snapshot.routeStatus ?? []) as WorldStateSnapshot['routeStatus'],
    forbiddenZones: (fix.snapshot.forbiddenZones ?? []) as WorldStateSnapshot['forbiddenZones'],
    lockedAssignments: (fix.snapshot.lockedAssignments ?? []) as WorldStateSnapshot['lockedAssignments'],
    safetyBlockedPersonIds: fix.snapshot.safetyBlockedPersonIds ?? [],
  };
}

function fixturePolicy(fix: FixtureFile): SchedulingPolicy {
  const w = fix.weights;
  return {
    version: 1,
    solverVersion: fix.solverVersion,
    weights: w,
    latenessWeight: w.lateness,
    walkingWeight: w.travel,
    workloadBalanceWeight: w.workload,
    stationWaitWeight: w.wait,
    changeCostWeight: w.change,
    riskWeight: w.risk,
    energyWeight: w.energy,
  };
}

function makeHeuristic(fix: FixtureFile) {
  const routeInfeasible = fix.expected.routeInfeasible === true;
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue(
      routeInfeasible
        ? {
            routeId: null,
            distanceMeters: 0,
            etaSeconds: 0,
            riskLevel: null,
            feasible: false,
            source: 'euclidean_fallback' as const,
            riskCost: 0,
            congestionCost: 0,
            graphVersion: null,
            calculatedAt: new Date().toISOString(),
            fallbackReason: 'no_route_edge' as const,
            dataQuality: 'FRESH' as const,
          }
        : {
            routeId: 'ROUTE-FIXTURE',
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
          },
    ),
  };
  const policyService = {
    getActivePolicy: jest.fn().mockResolvedValue(fixturePolicy(fix)),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const routing = { calculateRoute: jest.fn().mockResolvedValue({ routeId: 'ROUTE-FIXTURE' }) };
  const solver = new HeuristicSchedulingSolver(
    policyService as never,
    routing as never,
    routeCostProvider as never,
    new EligibilityService(),
  );
  return { solver, routeCostProvider };
}

function constraintsFor(fix: FixtureFile): SchedulingConstraint[] {
  const mb = fix.expected.minBatteryConstraint;
  return mb ? [{ type: 'MIN_BATTERY' as const, value: mb.value }] : [];
}

function structural(plan: SchedulingPlanV2) {
  const { createdAt: _ca, solveDurationMs: _sd, ...rest } = plan;
  return rest;
}

describe('P2-T3: 固定 fixtures 确定性重放（14 场景）', () => {
  const fixtures = loadFixtures();
  expect(fixtures.length).toBeGreaterThanOrEqual(14);

  it.each(fixtures.map((f) => [f.name, f] as const))(
    '%s：两次求解完全一致 + solverStatus=HEURISTIC + objective 可复现',
    async (_name, fix) => {
      const { solver } = makeHeuristic(fix);
      let snapshot = buildSnapshot(fix);
      // partial-replan：仅受影响+冻结任务进入求解子图（无关任务被排除）。
      if (fix.expected.excludedTaskId) {
        snapshot = {
          ...snapshot,
          tasks: snapshot.tasks.filter((t) => t.id !== fix.expected.excludedTaskId),
        };
      }
      const constraints = constraintsFor(fix);
      const opts = {
        planId: `PLAN-FIX-${fix.name}`,
        triggerType: 'MANUAL' as const,
        triggerEntityId: null,
        snapshotVersion: snapshot.snapshotVersion,
        horizonMinutes: 480,
        policy: fixturePolicy(fix),
      };
      jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
      try {
        const planA = await solver.solve(snapshot, constraints, opts);
        const planB = await solver.solve(snapshot, constraints, opts);
        // 确定性重放：结构与 objective 完全一致。
        expect(structural(planA)).toEqual(structural(planB));
        expect(planA.objective).toBe(planB.objective);
        expect(planA.solverStatus).toBe('HEURISTIC');
        expect(planA.solverVersion).toBe(fix.solverVersion);
        expect(planA.objective).toBeGreaterThanOrEqual(0);

        // 按 expected 断言分配结果。
        const assignedIds = planA.assignments.map((a) => a.taskId);
        if (fix.expected.assignedTaskIds) {
          for (const tid of fix.expected.assignedTaskIds) {
            expect(assignedIds).toContain(tid);
          }
        }
        if (fix.expected.unassignedTaskIds) {
          for (const tid of fix.expected.unassignedTaskIds) {
            expect(assignedIds).not.toContain(tid);
          }
        }
        if (fix.expected.frozenTaskId) {
          expect(assignedIds).not.toContain(fix.expected.frozenTaskId);
        }
        if (fix.expected.assignedPersonId) {
          const asg = planA.assignments.find(
            (a) => a.taskId === (fix.expected.assignedTaskIds ?? [])[0],
          );
          expect(asg?.personId).toBe(fix.expected.assignedPersonId);
        }
        if (fix.expected.manualDevice === true) {
          for (const a of planA.assignments) {
            expect(a.deviceId).toBeNull();
          }
        }
        if (fix.expected.predecessorOrder === true) {
          const sorted = [...planA.assignments].sort(
            (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
          );
          const pred = sorted.find((a) => a.taskId === 't-pred')!;
          const succ = sorted.find((a) => a.taskId === 't-succ')!;
          expect(Date.parse(pred.plannedEnd!)).toBeLessThanOrEqual(
            Date.parse(succ.plannedStart!),
          );
        }
        if (fix.expected.noOverlap === true) {
          const sorted = [...planA.assignments].sort(
            (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
          );
          for (let i = 1; i < sorted.length; i++) {
            expect(Date.parse(sorted[i - 1].plannedEnd!)).toBeLessThanOrEqual(
              Date.parse(sorted[i].plannedStart!),
            );
          }
        }
        if (fix.expected.violation) {
          expect(
            planA.violations.some(
              (v) => v.reason === fix.expected.violation,
            ),
          ).toBe(true);
        }
      } finally {
        jest.restoreAllMocks();
      }
    },
  );
});
