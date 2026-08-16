/* Task 11 / 11.2：Command Map 客户端性能基准（big-data 体验）。
 *
 * 测量三类成本，全部可在 node 环境运行（无浏览器/DOM 依赖）：
 * 1. `measureShellRender`：注入渲染函数（测试中为 renderToString(CommandMapShell)
 *    + 预置 500/1000 任务大 fixture 的 React Query 缓存），报告 Shell 首绘耗时
 *    （均值 / 最大值 / p95，等价"first-paint shell render"预算口径）；
 * 2. `measureVirtualization`：computeVirtualRange 长列表虚拟化行为
 *    （1000+ 行只渲染可视窗口行数）；
 * 3. `measureSseBatching`：createEventBatcher + coalesceEvents 高频 SSE 突发
 *    合并（原始事件数 vs store 写出次数，写放大削减百分比）。
 *
 * `runCommandMapBenchmark` 汇总为 output/benchmark-command-map.json
 * （output/ 已在 .gitignore，产物不入库），并附硬预算判定结果供 CI gate 消费。
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeVirtualRange } from '@client/src/lib/virtualList';
import {
  coalesceEvents,
  createEventBatcher,
  type EventBatch,
} from '../hooks/schedulerRealtimeCore';
import type { WorldStateSnapshot } from '@shared/scheduler';
import type {
  CurrentWorldState,
  DeviceInfo,
  EnvironmentReading,
  EventInfo,
  OrganizationInfo,
  OverviewStats,
  PersonnelInfo,
  ReplaySnapshot,
  ResourceState,
  RouteGraph,
  SchedulingConflict,
  SpatialEntity,
} from '@shared/api.interface';
import type { SchedulingPlanV2, SchedulingAssignment } from '@shared/scheduler';

export interface CommandMapPerfReport {
  meta: {
    generatedAt: string;
    fixture: {
      tasks: number;
      resources: number;
      conflicts: number;
      events: number;
      plans: number;
    };
  };
  shellRenderMs: {
    iterations: number;
    samples: number[];
    mean: number;
    max: number;
    p95: number;
    budgetMs: number;
    passed: boolean;
  };
  virtualization: Array<{
    total: number;
    viewport: number;
    itemHeight: number;
    scrollTop: number;
    renderedRows: number;
    totalHeight: number;
    sliceRatio: number;
    budgetRows: number;
    passed: boolean;
  }>;
  sseBatching: {
    rawEvents: number;
    flushes: number;
    keptEvents: number;
    /** 合并后实际写出的业务事件数（≈ React 状态更新/缓存写出次数）。 */
    storeWrites: number;
    writeReductionPct: number;
    seqGuardPreserved: boolean;
    structuralEventsAppliedInOrder: boolean;
  };
  budgets: {
    shellRenderMs: { budgetMs: number; passed: boolean };
    maxSliceRows: { budgetRows: number; passed: boolean };
    sseWriteReductionMinPct: { minPct: number; passed: boolean };
  };
}

/** CI 硬预算（宽松安全界，避免 CI 机器波动误伤；与 perf.yml command-map-perf-gate 一致）。 */
export const BUDGETS = {
  /** Shell 首绘渲染预算（ms）：1000 任务 fixture 的 renderToString 均值。 */
  shellRenderMs: 15_000,
  /** 虚拟化预算：1000 行列表可视窗口渲染行数上限。 */
  maxSliceRows: 100,
  /** SSE 批处理预算：合并后 store 写出相对原始事件的最小削减百分比。 */
  sseWriteReductionMinPct: 90,
} as const;

/* ------------------------------------------------------------------ *
 * fixture 构造（大样本但不追求类型完备；以 `as unknown as` 收敛非关键字段）
 * ------------------------------------------------------------------ */

export interface LargeFixture {
  snapshot: WorldStateSnapshot;
  plans: SchedulingPlanV2[];
  conflicts: SchedulingConflict[];
  events: EventInfo[];
  entities: SpatialEntity[];
  worldState: CurrentWorldState;
  devices: DeviceInfo[];
  personnel: PersonnelInfo[];
  organizations: OrganizationInfo[];
  routeGraph: RouteGraph;
  overview: OverviewStats;
  resources: ResourceState[];
  environmentReadings: EnvironmentReading[];
  replaySnapshots: ReplaySnapshot[];
}

/**
 * 构造大 fixture：
 * - tasks 个任务（分配进 plans[0].assignments 与 snapshot.tasks/stations）；
 * - resources 个资源（人员 + 设备 + 工位按 6:3:1 切分，进 entities/worldState/资源投影）；
 * - conflicts 个冲突（覆盖高/中/低严重度）；
 * - events 个事件（覆盖 L1/L2/L3 与 open/handled 状态）。
 */
export function buildLargeFixture(params: {
  tasks?: number;
  resources?: number;
  conflicts?: number;
  events?: number;
}): LargeFixture {
  const tasks = params.tasks ?? 500;
  const resources = params.resources ?? 200;
  const conflicts = params.conflicts ?? 80;
  const events = params.events ?? 120;

  const personCount = Math.max(1, Math.floor(resources * 0.6));
  const deviceCount = Math.max(1, Math.floor(resources * 0.3));
  const stationCount = Math.max(1, resources - personCount - deviceCount);
  const stationIds = Array.from({ length: stationCount }, (_, i) => `ST-${String(i + 1).padStart(3, '0')}`);

  const assignments = Array.from({ length: tasks }, (_, i) => ({
    assignmentId: `ASN-${i + 1}`,
    taskId: `T-${String(i + 1).padStart(4, '0')}`,
    personId: `P-${(i % personCount) + 1}`,
    deviceId: `D-${(i % deviceCount) + 1}`,
    stationId: stationIds[i % stationCount],
    zoneId: 'Z1',
    plannedStart: '2026-08-10T08:00:00.000Z',
    plannedEnd: '2026-08-10T09:00:00.000Z',
    routeId: null,
    etaSeconds: 120 + (i % 20) * 10,
    distanceMeters: 80 + (i % 15) * 5,
    status: i % 7 === 0 ? 'blocked' : 'scheduled',
    reasons: [],
    alternatives: [],
  })) as unknown as SchedulingAssignment[];

  const plan: SchedulingPlanV2 = {
    planId: 'PLAN-PERF-1000',
    planName: '性能基准方案',
    version: 1,
    status: 'approved',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-20260810-0001',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    solverStatus: 'OPTIMAL',
    objective: 1000,
    horizonMinutes: 480,
    assignments,
    metrics: { lateMinutes: 0, walkingMeters: 1000, stationWaitMinutes: 60, maxWorkload: 0.8, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: '2026-08-10T07:00:00.000Z',
  };

  const snapshot: WorldStateSnapshot = {
    snapshotVersion: 'WS-20260810-0001',
    ts: '2026-08-10T08:00:00.000Z',
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: Array.from({ length: personCount }, (_, i) => ({
      id: `P-${i + 1}`,
      name: `人员 ${i + 1}`,
      status: 'IDLE',
      healthStatus: 'HEALTHY',
      skills: ['assembly'],
      certifications: [],
      loadLevel: 0.5,
      fatigueLevel: 0.1,
      stationId: stationIds[i % stationCount],
      zoneId: 'Z1',
      x: (i % 20) * 2,
      y: Math.floor(i / 20) * 2,
    })),
    tasks: assignments.map((a) => ({
      id: a.taskId,
      title: `任务 ${a.taskId}`,
      taskType: 'assembly',
      priority: 'high',
      status: 'pending',
      assigneeId: a.personId,
      deviceId: a.deviceId,
      stationId: a.stationId,
      zoneId: 'Z1',
      planStart: a.plannedStart,
      planEnd: a.plannedEnd,
      progress: 0,
      predecessorIds: [],
      requiredSkills: ['assembly'],
      requiredCertifications: [],
    })),
    devices: Array.from({ length: deviceCount }, (_, i) => ({
      id: `D-${i + 1}`,
      workerName: null,
      deviceModel: 'exo-lift',
      batteryPct: 90 - (i % 40),
      online: true,
      status: 'AVAILABLE',
      capabilities: ['exo-lift'],
      x: (i % 15) * 3,
      y: Math.floor(i / 15) * 2,
    })),
    stations: stationIds.map((id, i) => ({ id, name: `工位 ${id}`, x: (i % 20) * 2, y: Math.floor(i / 20) * 2, capacity: 2 })),
    backlog: [],
    events: [],
    // 版本边界字段（P1-D）：与 context 一致，避免 STALE CONTEXT 误报干扰渲染路径。
    contextVersion: null,
    dataQuality: 'FRESH',
  } as unknown as WorldStateSnapshot;

  const entities: SpatialEntity[] = [
    ...Array.from({ length: personCount }, (_, i) => ({
      entityId: `P-${i + 1}`,
      name: `人员 ${i + 1}`,
      entityType: 'person',
      x: (i % 20) * 2,
      y: Math.floor(i / 20) * 2,
      status: 'idle',
      parentId: stationIds[i % stationCount],
      floorId: 'F1',
    })),
    ...Array.from({ length: deviceCount }, (_, i) => ({
      entityId: `D-${i + 1}`,
      name: `设备 ${i + 1}`,
      entityType: 'device',
      x: (i % 15) * 3,
      y: Math.floor(i / 15) * 2,
      status: 'online',
      parentId: stationIds[i % stationCount],
      floorId: 'F1',
      extra: { batteryPct: 90 - (i % 40) },
    })),
    ...stationIds.map((id, i) => ({
      entityId: id,
      name: `工位 ${id}`,
      entityType: 'workstation',
      x: (i % 20) * 2,
      y: Math.floor(i / 20) * 2,
      status: 'idle',
      parentId: null,
      floorId: 'F1',
    })),
  ] as unknown as SpatialEntity[];

  const worldState: CurrentWorldState = {
    persons: snapshot.persons.map((p) => ({
      entityId: p.id,
      name: p.name,
      x: p.x ?? 0,
      y: p.y ?? 0,
      status: p.status,
      confidence: 0.99,
      loadScore: p.loadLevel,
    })),
    devices: snapshot.devices.map((d) => ({
      entityId: d.id,
      name: `设备 ${d.id}`,
      x: d.x ?? 0,
      y: d.y ?? 0,
      status: d.online ? 'online' : 'offline',
      deviceId: d.id,
    })),
    workstations: snapshot.stations.map((s) => ({
      entityId: s.id,
      name: s.name,
      x: s.x ?? 0,
      y: s.y ?? 0,
      status: 'idle',
      occupancy: 0.4,
    })),
  } as CurrentWorldState;

  const conflictItems: SchedulingConflict[] = Array.from({ length: conflicts }, (_, i) => ({
    conflictId: `CF-${String(i + 1).padStart(3, '0')}`,
    type: (['double_booking', 'low_battery', 'person_unavailable', 'device_offline', 'stale_plan'] as const)[i % 5],
    severity: (['high', 'medium', 'low'] as const)[i % 3],
    scope: 'resource',
    resourceId: `P-${(i % personCount) + 1}`,
    resourceType: 'person',
    taskIds: [assignments[i % tasks].taskId],
    message: `冲突 ${i + 1}：资源被重复占用`,
    resolution: '建议重新分配资源',
    createdAt: '2026-08-10T08:00:00.000Z',
    snapshotVersion: 'WS-20260810-0001',
    status: 'OPEN',
    detectedAt: '2026-08-10T08:00:00.000Z',
  }));

  const eventItems: EventInfo[] = Array.from({ length: events }, (_, i) => ({
    id: `EV-${String(i + 1).padStart(3, '0')}`,
    eventId: `EV-${String(i + 1).padStart(3, '0')}`,
    title: `事件 ${i + 1}`,
    severity: (['critical', 'high', 'medium'] as const)[i % 3],
    status: i % 3 === 0 ? 'handled' : 'open',
    deviceId: `D-${(i % deviceCount) + 1}`,
    eventCode: `EC-${1000 + i}`,
    eventType: 'device_alert',
    createdAt: '2026-08-10T08:00:00.000Z',
    handlerAction: i % 3 === 0 ? 'manual_handle' : undefined,
  }));

  const resourceItems = [
    ...snapshot.persons.map((p, i) => ({
      id: p.id,
      type: 'person' as const,
      status: i % 5 === 0 ? 'BUSY' : 'AVAILABLE',
      capabilities: ['assembly'],
      certifications: [],
      location: { stationId: p.stationId, zoneId: p.zoneId, x: p.x, y: p.y },
      availableWindows: [],
      reservations: [],
      telemetry: { batteryPct: null, loadLevel: p.loadLevel, fatigueLevel: p.fatigueLevel, healthStatus: p.healthStatus },
    })),
    ...snapshot.devices.map((d) => ({
      id: d.id,
      type: 'device' as const,
      status: d.online ? 'AVAILABLE' : 'OFFLINE',
      capabilities: d.capabilities ?? [],
      certifications: [],
      location: { stationId: null, zoneId: 'Z1', x: d.x, y: d.y },
      availableWindows: [],
      reservations: [],
      telemetry: { batteryPct: d.batteryPct, loadLevel: null, fatigueLevel: null, healthStatus: null },
    })),
  ] as unknown as ResourceState[];

  const routeGraph: RouteGraph = {
    nodes: stationIds.map((id, i) => ({ nodeId: id, nodeType: 'workstation', x: (i % 20) * 2, y: Math.floor(i / 20) * 2 })),
    edges: [],
    blockedEdges: [],
    costs: {},
  } as unknown as RouteGraph;

  const deviceInfos: DeviceInfo[] = snapshot.devices.map((d, i) => ({
    deviceId: d.id,
    entityId: d.id,
    name: `设备 ${d.id}`,
    online: d.online,
    batteryPct: d.batteryPct,
    parentId: stationIds[i % stationCount],
    model: d.deviceModel,
  })) as unknown as DeviceInfo[];

  return {
    snapshot,
    plans: [plan],
    conflicts: conflictItems,
    events: eventItems,
    entities,
    worldState,
    devices: deviceInfos,
    personnel: snapshot.persons.map((p, i) => ({
      id: p.id,
      employeeNo: p.id,
      name: p.name,
      roles: ['worker'],
      status: 'active',
      orgId: 'default-factory',
      skills: p.skills,
      certifications: p.certifications,
      currentStationId: p.stationId,
    })) as unknown as PersonnelInfo[],
    organizations: [
      { orgId: 'default-factory', name: '默认工厂', code: 'F-001' },
    ] as unknown as OrganizationInfo[],
    routeGraph,
    overview: {
      deviceTotal: deviceCount,
      deviceOnline: deviceCount,
      eventOpen: Math.floor(events * 0.6),
      eventCritical: Math.floor(events * 0.2),
      avgLoad: 62,
      workerCount: personCount,
    },
    resources: resourceItems,
    environmentReadings: Array.from({ length: 40 }, (_, i) => ({
      id: `ENV-${i + 1}`,
      sensorId: `S-${i + 1}`,
      entityId: stationIds[i % stationCount],
      temperature: 24 + (i % 8),
      vibration: null,
      noise: 70 + (i % 20),
      airQuality: 90 - (i % 30),
      ts: '2026-08-10T08:00:00.000Z',
    })),
    replaySnapshots: [],
  };
}

/* ------------------------------------------------------------------ *
 * 测量函数（纯逻辑，node 可测）
 * ------------------------------------------------------------------ */

export interface VirtualizationSample {
  total: number;
  viewport: number;
  itemHeight: number;
  scrollTop: number;
  renderedRows: number;
  totalHeight: number;
  sliceRatio: number;
}

/** 长列表虚拟化行为：给定大列表尺寸，报告实际渲染行数（可见窗口 + overscan）。 */
export function measureVirtualization(params: {
  total?: number;
  viewport?: number;
  itemHeight?: number;
  scrollTop?: number;
}): VirtualizationSample {
  const total = params.total ?? 1000;
  const viewport = params.viewport ?? 400;
  const itemHeight = params.itemHeight ?? 40;
  const scrollTop = params.scrollTop ?? 0;
  const range = computeVirtualRange(total, viewport, itemHeight, scrollTop, 4);
  return {
    total,
    viewport,
    itemHeight,
    scrollTop,
    renderedRows: range.end - range.start,
    totalHeight: range.totalHeight,
    sliceRatio: total > 0 ? (range.end - range.start) / total : 0,
  };
}

export interface SseBatchingSample {
  rawEvents: number;
  flushes: number;
  keptEvents: number;
  storeWrites: number;
  writeReductionPct: number;
  seqGuardPreserved: boolean;
  structuralEventsAppliedInOrder: boolean;
}

/**
 * 高频 SSE 突发合并测量：在单个窗口内推入 rawEvents 条遥测事件（夹杂少量
 * 结构性事件），统计 flush 次数与最终写出的事件数。
 */
export function measureSseBatching(rawEvents = 10_000): SseBatchingSample {
  let scheduled: (() => void) | null = null;
  const schedule = (fn: () => void) => {
    scheduled = fn;
    return { cancel: () => (scheduled = null) };
  };
  const fire = () => {
    const fn = scheduled;
    scheduled = null;
    fn?.();
  };

  const batches: Array<EventBatch<{ eventId: string; eventType: string; sequence: number }>> = [];
  const batcher = createEventBatcher<{ eventId: string; eventType: string; sequence: number }>({
    windowMs: 100,
    maxBatchSize: 256,
    onFlush: (batch) => batches.push(batch),
    schedule,
  });

  let structuralSeqs: number[] = [];
  for (let seq = 1; seq <= rawEvents; seq += 1) {
    const isStructural = seq % 997 === 0; // 结构性事件（plan.changed 等）
    batcher.push({
      eventId: `E${seq}`,
      eventType: isStructural ? 'plan.changed' : 'device.telemetry',
      sequence: seq,
    });
    if (isStructural) structuralSeqs.push(seq);
  }
  fire();
  // 事件全量推入 → 结构性事件已即时 flush，剩余遥测在窗口 flush 后全部写出。
  // 再补一次 flush 兜底（防 maxBatchSize 边界残留）。
  batcher.flush();

  const allEvents = batches.flatMap((b) => b.events);
  const storeWrites = allEvents.length;
  const writeReductionPct = rawEvents > 0 ? Math.round(((rawEvents - storeWrites) / rawEvents) * 100) : 0;
  // 保序验证：写出事件 sequence 严格递增（单调守卫可安全消费）。
  const seqGuardPreserved = allEvents.every((e, i) => i === 0 || e.sequence > allEvents[i - 1].sequence);
  // 结构性事件逐条按序保留。
  const structuralApplied = allEvents.filter((e) => e.eventType === 'plan.changed').map((e) => e.sequence);
  const structuralEventsAppliedInOrder =
    structuralApplied.length === structuralSeqs.length &&
    structuralApplied.every((s, i) => s === structuralSeqs[i]);

  return {
    rawEvents,
    flushes: batches.length,
    keptEvents: coalesceEvents(allEvents).length,
    storeWrites,
    writeReductionPct,
    seqGuardPreserved,
    structuralEventsAppliedInOrder,
  };
}

/** 渲染耗时测量：注入渲染函数（测试中为 renderToString(Shell)），返回样本统计。 */
export function measureShellRender(
  render: () => string,
  iterations = 3,
): { iterations: number; samples: number[]; mean: number; max: number; p95: number } {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    render();
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { iterations, samples, mean, max: sorted[sorted.length - 1], p95 };
}

/* ------------------------------------------------------------------ *
 * 报告汇总 + 落盘
 * ------------------------------------------------------------------ */

export function buildReport(params: {
  fixture: LargeFixture;
  shell: { iterations: number; samples: number[]; mean: number; max: number; p95: number };
  virtualizationSamples: VirtualizationSample[];
  sse: SseBatchingSample;
}): CommandMapPerfReport {
  const { fixture, shell, virtualizationSamples, sse } = params;

  const shellRender = {
    iterations: shell.iterations,
    samples: shell.samples,
    mean: Math.round(shell.mean * 10) / 10,
    max: Math.round(shell.max * 10) / 10,
    p95: Math.round(shell.p95 * 10) / 10,
    budgetMs: BUDGETS.shellRenderMs,
    passed: shell.mean <= BUDGETS.shellRenderMs,
  };

  const virtualization = virtualizationSamples.map((s) => ({
    ...s,
    budgetRows: BUDGETS.maxSliceRows,
    passed: s.renderedRows <= BUDGETS.maxSliceRows,
  }));

  const sseBatching = {
    ...sse,
    flushes: sse.flushes,
    passed: sse.writeReductionPct >= BUDGETS.sseWriteReductionMinPct,
  };

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      fixture: {
        tasks: fixture.plans[0]?.assignments.length ?? 0,
        resources: fixture.entities.length,
        conflicts: fixture.conflicts.length,
        events: fixture.events.length,
        plans: fixture.plans.length,
      },
    },
    shellRenderMs: shellRender,
    virtualization,
    sseBatching,
    budgets: {
      shellRenderMs: { budgetMs: BUDGETS.shellRenderMs, passed: shellRender.passed },
      maxSliceRows: {
        budgetRows: BUDGETS.maxSliceRows,
        passed: virtualization.every((s) => s.passed),
      },
      sseWriteReductionMinPct: {
        minPct: BUDGETS.sseWriteReductionMinPct,
        passed: sse.writeReductionPct >= BUDGETS.sseWriteReductionMinPct,
      },
    },
  };
}

/** 写入 output/benchmark-command-map.json（output/ 已 gitignore，产物不入库）。 */
export function writeReport(report: CommandMapPerfReport): string {
  const dir = path.resolve(process.cwd(), 'output');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'benchmark-command-map.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
  return file;
}

/** 汇总打印（人类可读摘要）。 */
export function printSummary(report: CommandMapPerfReport): void {
  const { shellRenderMs, virtualization, sseBatching, budgets } = report;
  // 基准报告工具脚本输出（非应用代码，允许 console）
  // eslint-disable-next-line no-restricted-syntax
  console.log(
    `[command-map-perf] fixture tasks=${report.meta.fixture.tasks} resources=${report.meta.fixture.resources} conflicts=${report.meta.fixture.conflicts} events=${report.meta.fixture.events}\n` +
      `  shellRenderMs(mean/max/p95)=${shellRenderMs.mean}/${shellRenderMs.max}/${shellRenderMs.p95} (budget ${budgets.shellRenderMs.budgetMs}ms) → ${budgets.shellRenderMs.passed ? 'PASS' : 'FAIL'}\n` +
      `  virtualization: ${virtualization.map((v) => `total=${v.total}→render=${v.renderedRows} (${(v.sliceRatio * 100).toFixed(1)}%)`).join(' | ')} (budget ${budgets.maxSliceRows.budgetRows} rows) → ${budgets.maxSliceRows.passed ? 'PASS' : 'FAIL'}\n` +
      `  sseBatching: raw=${sseBatching.rawEvents} flushes=${sseBatching.flushes} storeWrites=${sseBatching.storeWrites} reduction=${sseBatching.writeReductionPct}% seqGuard=${sseBatching.seqGuardPreserved} structuralOrder=${sseBatching.structuralEventsAppliedInOrder} (budget ≥${budgets.sseWriteReductionMinPct.minPct}%) → ${budgets.sseWriteReductionMinPct.passed ? 'PASS' : 'FAIL'}`,
  );
}
