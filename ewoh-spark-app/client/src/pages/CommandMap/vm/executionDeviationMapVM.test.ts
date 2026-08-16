// executionDeviationMapVM.test.ts — 地图端执行偏差视图模型纯函数测试（node 可测）。
//
// 覆盖（R-6 / ADR-035）：
// - 空态/无偏差记录如实返回；
// - 纳入范围：deviated=deviationType 非空；ontrack=无偏差 STARTED/PAUSED；终态无偏差排除；
// - 坐标解析：计划点=任务工位；任务缺失回退 execution.stationId；实际点=人员→设备回退；
// - 坐标缺失显式 null + missingCoordinates 记录（不伪造 0,0）；
// - delta 按偏差类型取事实对（START_DELAY/END_DELAY/TRAVEL_DELAY/其他 null）；
// - 未知偏差类型原样透出 label、tone=neutral（不当作正常静默吞掉）；
// - tone 映射（critical/warning/neutral）；保持输入顺序。
import { buildExecutionDeviationMapView } from './executionDeviationMapVM';
import type { SchedulingExecution, WorldStateSnapshot } from '@shared/scheduler';

function exec(overrides: Partial<SchedulingExecution>): SchedulingExecution {
  return {
    id: 'row-1',
    executionId: 'EXEC-1',
    orgId: null,
    runId: null,
    planId: 'PLAN-1',
    assignmentId: 'ASGN-1',
    taskId: 'TASK-1',
    personId: 'P-1',
    deviceId: null,
    stationId: null,
    plannedStartAt: null,
    plannedEndAt: null,
    actualStartAt: null,
    actualEndAt: null,
    plannedTravelMs: null,
    actualTravelMs: null,
    plannedDistanceM: null,
    actualDistanceM: null,
    plannedWaitingMs: null,
    actualWaitingMs: null,
    status: 'PLANNED',
    deviationType: null,
    deviationReason: null,
    snapshotVersion: null,
    policyVersion: null,
    solverVersion: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

type SnapshotPerson = WorldStateSnapshot['persons'][number];
type SnapshotTask = WorldStateSnapshot['tasks'][number];
type SnapshotDevice = WorldStateSnapshot['devices'][number];
type SnapshotStation = WorldStateSnapshot['stations'][number];

function snapshot(overrides: {
  persons?: SnapshotPerson[];
  tasks?: SnapshotTask[];
  devices?: SnapshotDevice[];
  stations?: SnapshotStation[];
}): WorldStateSnapshot {
  return {
    snapshotVersion: 'SV-1',
    ts: '2026-08-16T08:00:00.000Z',
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: overrides.persons ?? [],
    tasks: overrides.tasks ?? [],
    devices: overrides.devices ?? [],
    stations: overrides.stations ?? [],
    backlog: [],
    events: [],
  } as WorldStateSnapshot;
}

function person(id: string, x: number | null, y: number | null): SnapshotPerson {
  return {
    id,
    name: id,
    status: 'AVAILABLE',
    healthStatus: null,
    skills: [],
    certifications: [],
    loadLevel: 0,
    fatigueLevel: 0,
    stationId: null,
    zoneId: null,
    x,
    y,
  };
}

function task(id: string, stationId: string | null): SnapshotTask {
  return {
    id,
    title: id,
    taskType: 'manual',
    priority: 'medium',
    status: 'pending',
    assigneeId: null,
    deviceId: null,
    stationId,
    zoneId: null,
    planStart: null,
    planEnd: null,
    progress: 0,
    predecessorIds: [],
    requiredSkills: [],
    requiredCertifications: [],
  };
}

function station(id: string, x: number | null, y: number | null): SnapshotStation {
  return { id, name: id, x, y };
}

const SNAP = snapshot({
  persons: [person('P-1', 30, 40)],
  tasks: [task('TASK-1', 'ST-1')],
  stations: [station('ST-1', 10, 20)],
});

describe('buildExecutionDeviationMapView', () => {
  it('空执行列表 → deviated/ontrack/missingCoordinates 全空', () => {
    const view = buildExecutionDeviationMapView({ executions: [], snapshot: SNAP });
    expect(view).toEqual({ deviated: [], ontrack: [], missingCoordinates: [] });
  });

  it('null 输入 → 空态（不静默透传 null）', () => {
    const view = buildExecutionDeviationMapView({ executions: null, snapshot: null });
    expect(view.deviated).toEqual([]);
    expect(view.ontrack).toEqual([]);
    expect(view.missingCoordinates).toEqual([]);
  });

  it('deviated：deviationType 非空 → 纳入 deviated，计划点=任务工位、实际点=人员', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({
          deviationType: 'START_DELAY',
          status: 'STARTED',
          plannedStartAt: '2026-08-16T08:00:00.000Z',
          actualStartAt: '2026-08-16T08:03:00.000Z',
        }),
      ],
      snapshot: SNAP,
    });
    expect(view.deviated).toHaveLength(1);
    const e = view.deviated[0];
    expect(e.deviationType).toBe('START_DELAY');
    expect(e.deviationLabel).toBe('开始延误');
    expect(e.tone).toBe('warning');
    expect(e.plannedPoint).toEqual({ x: 10, y: 20 });
    expect(e.actualPoint).toEqual({ x: 30, y: 40 });
    expect(e.deltaMs).toBe(3 * 60_000);
    expect(e.deltaLabel).toBe('+3.0min');
    expect(view.ontrack).toEqual([]);
    expect(view.missingCoordinates).toEqual([]);
  });

  it('ontrack：无偏差 STARTED/PAUSED → 纳入 ontrack；无偏差终态排除', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({ executionId: 'E-RUN', status: 'STARTED' }),
        exec({ executionId: 'E-PAUSE', status: 'PAUSED' }),
        exec({ executionId: 'E-DONE', status: 'COMPLETED' }),
        exec({ executionId: 'E-FAIL', status: 'FAILED' }),
        exec({ executionId: 'E-PLAN', status: 'PLANNED' }),
      ],
      snapshot: SNAP,
    });
    expect(view.ontrack.map((e) => e.executionId)).toEqual(['E-RUN', 'E-PAUSE']);
    expect(view.deviated).toEqual([]);
  });

  it('任务不在快照 → 计划点回退 execution.stationId', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({ deviationType: 'END_DELAY', stationId: 'ST-1' }),
      ],
      snapshot: snapshot({ persons: [person('P-1', 5, 6)], tasks: [], stations: [station('ST-1', 7, 8)] }),
    });
    expect(view.deviated[0].plannedPoint).toEqual({ x: 7, y: 8 });
  });

  it('人员无坐标 → 回退设备坐标；均无 → null + missingCoordinates', () => {
    const deviceSnap = snapshot({
      persons: [person('P-1', null, null)],
      tasks: [task('TASK-1', 'ST-1')],
      devices: [{ id: 'D-1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: null, x: 50, y: 60 }],
      stations: [station('ST-1', 10, 20)],
    });
    const withDevice = buildExecutionDeviationMapView({
      executions: [exec({ deviationType: 'ROUTE_DEVIATION', deviceId: 'D-1' })],
      snapshot: deviceSnap,
    });
    expect(withDevice.deviated[0].actualPoint).toEqual({ x: 50, y: 60 });
    expect(withDevice.missingCoordinates).toEqual([]);

    const noCoords = buildExecutionDeviationMapView({
      executions: [exec({ deviationType: 'ROUTE_DEVIATION', deviceId: 'D-9' })],
      snapshot: deviceSnap,
    });
    expect(noCoords.deviated[0].actualPoint).toBeNull();
    expect(noCoords.missingCoordinates).toEqual(['EXEC-1']);
  });

  it('计划工位坐标缺失（null）→ plannedPoint=null + missingCoordinates，不伪造 0,0', () => {
    const view = buildExecutionDeviationMapView({
      executions: [exec({ deviationType: 'TASK_CANCELLED' })],
      snapshot: snapshot({
        persons: [person('P-1', 1, 2)],
        tasks: [task('TASK-1', 'ST-1')],
        stations: [station('ST-1', null, null)],
      }),
    });
    expect(view.deviated[0].plannedPoint).toBeNull();
    expect(view.deviated[0].actualPoint).toEqual({ x: 1, y: 2 });
    expect(view.missingCoordinates).toEqual(['EXEC-1']);
  });

  it('delta 按偏差类型取事实对：END_DELAY/TRAVEL_DELAY 正确，其他类型 null', () => {
    const endDelay = buildExecutionDeviationMapView({
      executions: [
        exec({
          executionId: 'E-END',
          deviationType: 'END_DELAY',
          plannedEndAt: '2026-08-16T09:00:00.000Z',
          actualEndAt: '2026-08-16T09:04:00.000Z',
        }),
        exec({
          executionId: 'E-TRAVEL',
          deviationType: 'TRAVEL_DELAY',
          plannedTravelMs: 100_000,
          actualTravelMs: 150_000,
        }),
        exec({ executionId: 'E-OTHER', deviationType: 'PERSON_CHANGED' }),
      ],
      snapshot: SNAP,
    });
    const byId = new Map(endDelay.deviated.map((e) => [e.executionId, e]));
    expect(byId.get('E-END')?.deltaMs).toBe(4 * 60_000);
    expect(byId.get('E-END')?.deltaLabel).toBe('+4.0min');
    expect(byId.get('E-TRAVEL')?.deltaMs).toBe(50_000);
    expect(byId.get('E-TRAVEL')?.deltaLabel).toBe('+50s');
    expect(byId.get('E-OTHER')?.deltaMs).toBeNull();
    expect(byId.get('E-OTHER')?.deltaLabel).toBeNull();
  });

  it('delta 事实缺失（planned 或 actual 时间 null）→ null（不猜）', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({ deviationType: 'START_DELAY', plannedStartAt: null, actualStartAt: '2026-08-16T08:00:00.000Z' }),
      ],
      snapshot: SNAP,
    });
    expect(view.deviated[0].deltaMs).toBeNull();
  });

  it('负 delta（提前）→ 带符号 label', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({
          deviationType: 'START_DELAY',
          plannedStartAt: '2026-08-16T08:00:00.000Z',
          actualStartAt: '2026-08-16T07:59:30.000Z',
        }),
      ],
      snapshot: SNAP,
    });
    expect(view.deviated[0].deltaMs).toBe(-30_000);
    expect(view.deviated[0].deltaLabel).toBe('-30s');
  });

  it('tone 映射：DEVICE_FAILURE/SAFETY_INTERRUPTION=critical；资源变更=neutral', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({ executionId: 'E-FAIL', deviationType: 'DEVICE_FAILURE' }),
        exec({ executionId: 'E-SAFE', deviationType: 'SAFETY_INTERRUPTION' }),
        exec({ executionId: 'E-PER', deviationType: 'PERSON_CHANGED' }),
        exec({ executionId: 'E-OVR', deviationType: 'MANUAL_OVERRIDE' }),
      ],
      snapshot: SNAP,
    });
    const byId = new Map(view.deviated.map((e) => [e.executionId, e]));
    expect(byId.get('E-FAIL')?.tone).toBe('critical');
    expect(byId.get('E-SAFE')?.tone).toBe('critical');
    expect(byId.get('E-PER')?.tone).toBe('neutral');
    expect(byId.get('E-OVR')?.tone).toBe('neutral');
  });

  it('未知偏差类型 → label 原样透出、tone=neutral（显式可见，不当作正常）', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({
          // 运行时升级引入的新类型（编译期联合未含）：前端必须显式透出而非吞掉。
          deviationType: 'SOME_FUTURE_TYPE' as SchedulingExecution['deviationType'],
        }),
      ],
      snapshot: SNAP,
    });
    expect(view.deviated[0].deviationLabel).toBe('SOME_FUTURE_TYPE');
    expect(view.deviated[0].tone).toBe('neutral');
  });

  it('deviated 包含无偏差类型不匹配的状态（含终态偏差记录，供方案历史可见）', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({ executionId: 'E-CPL-DEV', deviationType: 'END_DELAY', status: 'COMPLETED' }),
        exec({ executionId: 'E-CAN-DEV', deviationType: 'TASK_CANCELLED', status: 'CANCELLED' }),
      ],
      snapshot: SNAP,
    });
    expect(view.deviated.map((e) => e.executionId)).toEqual(['E-CPL-DEV', 'E-CAN-DEV']);
  });

  it('保持输入顺序（deviated 与 ontrack 分别按原顺序）', () => {
    const view = buildExecutionDeviationMapView({
      executions: [
        exec({ executionId: 'E-D2', deviationType: 'START_DELAY' }),
        exec({ executionId: 'E-O1', status: 'STARTED' }),
        exec({ executionId: 'E-D1', deviationType: 'END_DELAY' }),
        exec({ executionId: 'E-O2', status: 'PAUSED' }),
      ],
      snapshot: SNAP,
    });
    expect(view.deviated.map((e) => e.executionId)).toEqual(['E-D2', 'E-D1']);
    expect(view.ontrack.map((e) => e.executionId)).toEqual(['E-O1', 'E-O2']);
  });

  it('statusLabel 透传服务端状态文案', () => {
    const view = buildExecutionDeviationMapView({
      executions: [exec({ deviationType: 'DEVICE_FAILURE', status: 'FAILED' })],
      snapshot: SNAP,
    });
    expect(view.deviated[0].statusLabel).toBe('执行失败');
  });
});
