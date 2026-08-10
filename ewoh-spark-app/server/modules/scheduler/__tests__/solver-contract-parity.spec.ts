/* TS↔Python 调度契约 golden fixture parity 测试（.trae/specs/scheduler-prod-convergence Task 3）。
 *
 * 同一份 golden JSON（仓库根 tests/golden-fixtures/scheduler-contract.golden.json）：
 *  - 本文件（jest）：断言 golden 顶层 key 集合与 shared/scheduler.ts 手写样例一致
 *    （无缺字段/无多余字段）、solverStatusValues 覆盖 SolverStatus 全部 7 值、
 *    JSON 往返稳定、golden 可安全断言为 SolverRequest/SolverResponse TS 类型。
 *  - Python 侧（tests/test_ts_python_contract_parity.py）：断言 from_dict/to_dict round-trip。
 *
 * 注意：字段名以 Python contract.py dataclass 为准，TS 接口与之一致（snapshotVersion /
 * solverVersion / objectiveBreakdown 等，两侧命名完全相同）。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import type { SolverRequest, SolverResponse } from '@shared/scheduler';

const GOLDEN_PATH = path.resolve(
  __dirname,
  '../../../../../tests/golden-fixtures/scheduler-contract.golden.json',
);
const goldenStr = fs.readFileSync(GOLDEN_PATH, 'utf8');

/** SolverStatus 联合的 7 个合法值（shared/scheduler.ts 权威清单，供 golden 对照）。 */
const SOLVER_STATUSES = [
  'OPTIMAL',
  'FEASIBLE',
  'HEURISTIC',
  'FALLBACK',
  'INFEASIBLE',
  'TIMEOUT',
  'UNAVAILABLE',
] as const;

/** 手写 SolverRequest 样例：与 golden.request 完全同构（TS 权威声明）。 */
const sampleRequest: SolverRequest = {
  requestId: 'REQ-PARITY-0001',
  snapshotVersion: 'WS-PARITY-0001',
  policyVersion: 7,
  solverVersion: 'cpsat-v1',
  horizonMinutes: 480,
  nowMs: 1_700_000_000_000,
  weights: {
    lateness: 100,
    travel: 50,
    workloadBalance: 40,
    stationWait: 30,
    changeCost: 20,
    risk: 80,
    energyRisk: 60,
    churn: 10,
  },
  tasks: [
    {
      taskId: 'T-101',
      priority: 1,
      earliestStartMs: 1_700_000_100_000,
      dueMs: 1_700_001_000_000,
      durationMs: 1_800_000,
      requiredSkills: ['assembly', 'weld'],
      requiredCertifications: ['c-weld-basic'],
      requiredDeviceCapabilities: ['exo-lift'],
      candidateStationIds: ['S-1', 'S-2'],
      zoneId: 'Z-1',
      predecessorIds: [],
      safetyCritical: true,
      preemptible: false,
      skillMatchMode: 'ALL',
      effectivePriorityScore: 12.5,
      mustFinishByMs: 1_700_001_600_000,
      eligiblePersonIds: ['P-1', 'P-2'],
      eligibleDeviceIds: ['D-1'],
    },
    {
      taskId: 'T-102',
      priority: 2,
      earliestStartMs: 1_700_000_200_000,
      dueMs: null,
      durationMs: 1_200_000,
      requiredSkills: ['inspect'],
      requiredCertifications: [],
      requiredDeviceCapabilities: [],
      candidateStationIds: ['S-3'],
      zoneId: null,
      predecessorIds: ['T-101'],
      safetyCritical: false,
      preemptible: true,
      skillMatchMode: 'ANY',
      effectivePriorityScore: 40,
      mustFinishByMs: null,
      eligiblePersonIds: ['P-2'],
      eligibleDeviceIds: [],
    },
  ],
  persons: [
    {
      id: 'P-1',
      status: 'AVAILABLE',
      locationStationId: 'S-1',
      x: 12.5,
      y: 8.25,
      skills: ['assembly', 'weld', 'inspect'],
      certifications: ['c-weld-basic'],
      workload: 0.3,
      fatigue: 0.2,
      availableFromMs: 1_700_000_100_000,
      executingTaskIds: [],
    },
    {
      id: 'P-2',
      status: 'AVAILABLE',
      locationStationId: null,
      x: null,
      y: null,
      skills: ['inspect'],
      certifications: [],
      workload: 0.1,
      fatigue: 0.05,
      availableFromMs: null,
      executingTaskIds: ['T-103'],
    },
  ],
  devices: [
    {
      id: 'D-1',
      status: 'AVAILABLE',
      online: true,
      capabilities: ['exo-lift'],
      batteryPct: 92,
      x: 11.0,
      y: 9.0,
      availableFromMs: 1_700_000_100_000,
      executingTaskIds: [],
    },
    {
      id: 'D-2',
      status: 'OFFLINE',
      online: false,
      capabilities: ['vacuum'],
      batteryPct: 10,
      x: null,
      y: null,
      availableFromMs: null,
      executingTaskIds: [],
    },
  ],
  stations: [
    { id: 'S-1', x: 10.0, y: 10.0, capacity: 1, executingTaskIds: [] },
    { id: 'S-2', x: 20.0, y: 5.0, capacity: 2, executingTaskIds: [] },
    { id: 'S-3', x: null, y: null, capacity: 1, executingTaskIds: [] },
  ],
  reservations: [
    { resourceId: 'P-1', resourceType: 'person', startMs: 1_700_001_000_000, endMs: 1_700_002_800_000 },
  ],
  forbiddenZones: ['Z-2'],
  constraints: [
    {
      id: 'C-1',
      type: 'REQUIRED_SKILL',
      taskId: 'T-101',
      personId: 'P-2',
      hard: true,
      operator: 'scheduler',
      reason: 'missing_skill',
      source: 'system',
      orgId: null,
      validFromMs: null,
      expiresAtMs: null,
      deactivatedAt: null,
      deactivatedBy: null,
    },
    {
      id: 'C-2',
      type: 'LOCKED_TIME',
      taskId: 'T-102',
      startMs: 1_700_000_200_000,
      endMs: 1_700_001_400_000,
      value: 0,
      hard: true,
      operator: 'dispatcher',
      reason: 'manual_lock',
      source: 'manual',
      orgId: 'org-ewoh-demo',
    },
  ],
  candidateCosts: [
    {
      taskId: 'T-101',
      personId: 'P-1',
      stationId: 'S-1',
      distanceMeters: 120.5,
      etaSeconds: 90,
      dataQuality: 'FRESH',
      fallbackReason: null,
    },
    {
      taskId: 'T-101',
      personId: 'P-2',
      stationId: 'S-2',
      distanceMeters: 0,
      etaSeconds: 0,
      dataQuality: 'UNKNOWN',
      fallbackReason: 'coords_unknown',
    },
  ],
  frozenAssignments: [
    {
      taskId: 'T-103',
      personId: 'P-2',
      deviceId: null,
      stationId: 'S-3',
      startMs: 1_700_000_200_000,
      endMs: 1_700_000_400_000,
    },
  ],
  safetyBlockedPersonIds: ['P-9'],
  safetyBlockedDeviceIds: ['D-9'],
  baselineAssignee: { 'T-101': 'P-1', 'T-102': null },
  timeLimitMs: 5000,
};

/** 手写 SolverResponse 样例：与 golden.response 完全同构。 */
const sampleResponse: SolverResponse = {
  solverVersion: 'cpsat-v1',
  solverStatus: 'OPTIMAL',
  solveDurationMs: 42,
  objective: 123.5,
  objectiveBreakdown: {
    lateness: 20,
    travel: 40,
    workloadBalance: 10,
    stationWait: 5,
    changeCost: 30,
    risk: 8,
    energyRisk: 8,
    churn: 2.5,
  },
  hardViolations: [],
  optimalityGap: 0,
  unassignedTaskIds: ['T-104'],
  assignments: [
    {
      taskId: 'T-101',
      personId: 'P-1',
      deviceId: 'D-1',
      stationId: 'S-1',
      startMs: 1_700_000_100_000,
      endMs: 1_700_001_900_000,
      reasons: ['cpsat-selected', 'skill_match'],
      rejectedAlternatives: [{ personId: 'P-2', stationId: 'S-2', reason: ['missing_skill'] }],
    },
    {
      taskId: 'T-102',
      personId: 'P-2',
      deviceId: null,
      stationId: 'S-3',
      startMs: 1_700_002_000_000,
      endMs: 1_700_003_200_000,
      reasons: ['cpsat-selected'],
      rejectedAlternatives: [],
    },
  ],
};

interface Golden {
  request: SolverRequest;
  response: SolverResponse;
  solverStatusValues: readonly string[];
}

const golden = JSON.parse(goldenStr) as Golden;

describe('TS↔Python 调度契约 golden parity', () => {
  it('golden.request 顶层 key 集合与 SolverRequest 样例一致（无缺字段/无多余字段）', () => {
    const sampleClone = JSON.parse(JSON.stringify(sampleRequest)) as Record<string, unknown>;
    const goldenKeys = Object.keys(golden.request).sort();
    const sampleKeys = Object.keys(sampleClone).sort();
    expect(goldenKeys).toEqual(sampleKeys);
  });

  it('golden.response 顶层 key 集合与 SolverResponse 样例一致（无缺字段/无多余字段）', () => {
    const sampleClone = JSON.parse(JSON.stringify(sampleResponse)) as Record<string, unknown>;
    const goldenKeys = Object.keys(golden.response).sort();
    const sampleKeys = Object.keys(sampleClone).sort();
    expect(goldenKeys).toEqual(sampleKeys);
  });

  it('solverStatusValues 覆盖 shared/scheduler.ts SolverStatus 联合全部 7 值', () => {
    expect([...golden.solverStatusValues].sort()).toEqual([...SOLVER_STATUSES].sort());
    expect(new Set(golden.solverStatusValues).size).toBe(SOLVER_STATUSES.length);
  });

  it('JSON 往返稳定：parse → stringify → parse 数据无损失（key 顺序无关深比较）', () => {
    const roundTripped = JSON.parse(JSON.stringify(golden));
    expect(roundTripped).toEqual(golden);
  });

  it('golden 可安全断言为 SolverRequest/SolverResponse TS 类型（不抛）', () => {
    const req = golden.request as SolverRequest;
    const resp = golden.response as SolverResponse;
    expect(typeof req.requestId).toBe('string');
    expect((SOLVER_STATUSES as readonly string[])).toContain(resp.solverStatus);
    // 关键嵌套结构抽查：weights 8 项、tasks ≥2、assignments ≥2 且含 reasons/rejectedAlternatives。
    expect(Object.keys(req.weights)).toHaveLength(8);
    expect(req.tasks.length).toBeGreaterThanOrEqual(2);
    expect(req.persons.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(req.constraints)).toBe(true);
    expect(Array.isArray(req.candidateCosts)).toBe(true);
    expect(Array.isArray(req.frozenAssignments)).toBe(true);
    expect(resp.assignments.length).toBeGreaterThanOrEqual(2);
    for (const a of resp.assignments) {
      expect(Array.isArray(a.reasons)).toBe(true);
      expect(Array.isArray(a.rejectedAlternatives)).toBe(true);
    }
  });
});
