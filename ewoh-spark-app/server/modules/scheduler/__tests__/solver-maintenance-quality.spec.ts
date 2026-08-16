/* NO-05c / NO-05d 求解器接线回归（heuristic reuse fast-path 守卫）。
 *
 * reuseBaseline fast-path 若遗漏维护/质量封锁复验，会把已封锁资源"复活"回
 * 基线分配——本 spec 显式验证三个守卫（person/device/station）在 reuse 路径
 * 上 fail-closed（复用被拒 → 回退完整枚举 → 同样拒派）。
 * 枚举路径的求解级行为由 golden-scheduler-scenarios.spec.ts 覆盖。
 */
/// <reference types="jest" />
import {
  makeSolver,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
} from './scheduler-test-helpers';

const CRITICAL_MAINTENANCE = [
  {
    conditionId: 'mc:1',
    conditionType: 'wear',
    severity: 'critical',
    status: 'detected',
    dueAt: null,
    overdue: false,
  },
];

const CRITICAL_QUALITY = [
  {
    findingId: 'qf:1',
    findingType: 'defect',
    severity: 'critical',
    status: 'open',
    disposition: null,
    links: ['station:S1'],
    detectedAt: '2026-08-16T08:00:00Z',
  },
];

describe('NO-05c/05d 求解器 reuse 路径守卫', () => {
  it('reuse 守卫：基线人员带活跃维护事实 → 不可复用（任务 unassigned）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [
        {
          ...seedPerson({ id: 'p1' }),
          maintenance: CRITICAL_MAINTENANCE,
        },
      ],
      tasks: [seedTask({ id: 't1' })],
    });
    const plan = await solver.solve(
      snapshot,
      [],
      {
        ...baseSolveOpts,
        policy: defaultPolicy(),
        reuseBaseline: new Map([['t1', { personId: 'p1', deviceId: null, stationId: null }]]),
      },
    );
    expect(plan.assignments.filter((a) => a.taskId === 't1')).toHaveLength(0);
    const violation = plan.violations.find(
      (v) => (v as Record<string, unknown>).taskId === 't1',
    ) as { alternatives?: Array<{ reasons?: string[] }> } | undefined;
    const reasons = (violation?.alternatives ?? []).flatMap((a) => a.reasons ?? []);
    expect(reasons).toContain('person_maintenance_blocked');
  });

  it('reuse 守卫：基线设备带活跃维护事实 → 不可复用（任务 unassigned）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [seedTask({ id: 't1', requiredDeviceCapabilities: ['vacuum'] })],
      devices: [
        {
          ...seedDevice({ id: 'd1' }),
          capabilities: ['vacuum'],
          maintenance: CRITICAL_MAINTENANCE,
        },
      ],
    });
    const plan = await solver.solve(
      snapshot,
      [],
      {
        ...baseSolveOpts,
        policy: defaultPolicy(),
        reuseBaseline: new Map([['t1', { personId: 'p1', deviceId: 'd1', stationId: null }]]),
      },
    );
    expect(plan.assignments.filter((a) => a.taskId === 't1')).toHaveLength(0);
    const violation = plan.violations.find(
      (v) => (v as Record<string, unknown>).taskId === 't1',
    ) as { alternatives?: Array<{ reasons?: string[] }> } | undefined;
    const reasons = (violation?.alternatives ?? []).flatMap((a) => a.reasons ?? []);
    expect(reasons).toContain('device_maintenance_blocked');
  });

  it('reuse 守卫：基线工位带 critical 活跃质量发现 → 不可复用（任务 unassigned）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [seedTask({ id: 't1', candidateStations: ['S1'] })],
      stations: [
        {
          id: 'S1',
          name: 'Station 1',
          x: 0,
          y: 0,
          capacity: null,
          queue: [],
          availableWindows: [],
          capabilities: ['station'],
          qualityFindings: CRITICAL_QUALITY,
        },
      ],
    });
    const plan = await solver.solve(
      snapshot,
      [],
      {
        ...baseSolveOpts,
        policy: defaultPolicy(),
        reuseBaseline: new Map([['t1', { personId: 'p1', deviceId: null, stationId: 'S1' }]]),
      },
    );
    expect(plan.assignments.filter((a) => a.taskId === 't1')).toHaveLength(0);
    const violation = plan.violations.find(
      (v) => (v as Record<string, unknown>).taskId === 't1',
    ) as { alternatives?: Array<{ reasons?: string[] }> } | undefined;
    const reasons = (violation?.alternatives ?? []).flatMap((a) => a.reasons ?? []);
    expect(reasons).toContain('station_quality_blocked');
  });

  it('reuse 正常路径不受影响：无封锁基线仍可复用', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [seedTask({ id: 't1' })],
    });
    const plan = await solver.solve(
      snapshot,
      [],
      {
        ...baseSolveOpts,
        policy: defaultPolicy(),
        reuseBaseline: new Map([['t1', { personId: 'p1', deviceId: null, stationId: null }]]),
      },
    );
    const assignment = plan.assignments.find((a) => a.taskId === 't1');
    expect(assignment).toBeDefined();
    expect(assignment!.personId).toBe('p1');
  });
});
