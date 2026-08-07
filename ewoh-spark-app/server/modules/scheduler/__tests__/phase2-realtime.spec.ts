/* Phase 2 实时闭环与局部重排测试（Task 2.1 / 2.2）。
 * - Task 2.1：SSE sequence 重放 / 缺口检测 / Last-Event-ID 去重 / 事件携带 entityType+entityVersion。
 * - Task 2.2：ImpactAnalyzer 统一异常分类 + 局部重排（DEVICE_OFFLINE 只重排受影响子图）。
 */
/// <reference types="jest" />
import { SchedulerStreamService, type ReplayResult } from '../scheduler-stream.service';
import { ImpactAnalyzer } from '../impact-analyzer';
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { OutboxEvent, SchedulingEvent, WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
} from './scheduler-test-helpers';

/* ===== Task 2.1: SSE 重放 / 缺口 / 幂等去重 ===== */

describe('SchedulerStreamService 重放与缺口恢复（Task 2.1）', () => {
  function makeOutbox(overrides: Partial<Record<'latestSequence' | 'listSince' | 'listLatest', jest.Mock>>) {
    return {
      latestSequence: overrides.latestSequence ?? jest.fn().mockResolvedValue(0),
      listSince: overrides.listSince ?? jest.fn().mockResolvedValue([]),
      listLatest: overrides.listLatest ?? jest.fn().mockResolvedValue([]),
    };
  }

  function evt(sequence: number, extra: Partial<OutboxEvent> = {}): OutboxEvent {
    return {
      id: `evt-${sequence}`,
      eventType: 'DEVICE_OFFLINE',
      entityId: 'd1',
      payload: {},
      status: 'published',
      sequence,
      createdAt: new Date().toISOString(),
      ...extra,
    };
  }

  it('replaySince 返回 afterSequence 的缺失事件（重连接续）', async () => {
    const outbox = makeOutbox({
      latestSequence: jest.fn().mockResolvedValue(5),
      listSince: jest.fn().mockResolvedValue([evt(4), evt(5)]),
    });
    const svc = new SchedulerStreamService(outbox as never);

    const result = await svc.replaySince(3);
    expect(result.resyncNeeded).toBe(false);
    expect(result.gap).toBe(false);
    expect(result.currentSequence).toBe(5);
    expect(result.events.map((e) => e.sequence)).toEqual([4, 5]);
  });

  it('客户端 sequence 超前于服务器 → 返回 RESYNC_NEEDED（需重新拉取快照）', async () => {
    const outbox = makeOutbox({ latestSequence: jest.fn().mockResolvedValue(5) });
    const svc = new SchedulerStreamService(outbox as never);

    const result = await svc.replaySince(10);
    expect(result.resyncNeeded).toBe(true);
    expect(result.gap).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('检测到 sequence 缺口（事件被裁剪）→ 返回 RESYNC_NEEDED', async () => {
    // since=3，但回放首条为 seq=5（seq=4 缺失）→ 增量无法安全续接。
    const outbox = makeOutbox({
      latestSequence: jest.fn().mockResolvedValue(6),
      listSince: jest.fn().mockResolvedValue([evt(5), evt(6)]),
    });
    const svc = new SchedulerStreamService(outbox as never);

    const result = await svc.replaySince(3);
    expect(result.resyncNeeded).toBe(true);
    expect(result.gap).toBe(true);
  });

  it('Last-Event-ID 幂等过滤：丢弃 sequence <= lastEventId 的重复事件', async () => {
    const outbox = makeOutbox({
      latestSequence: jest.fn().mockResolvedValue(5),
      listSince: jest.fn().mockResolvedValue([evt(4), evt(5)]),
    });
    const svc = new SchedulerStreamService(outbox as never);

    const result = await svc.replaySince(3, 4);
    expect(result.resyncNeeded).toBe(false);
    expect(result.events.map((e) => e.sequence)).toEqual([5]);
  });

  it('事件携带 sequence / entityType / entityVersion', async () => {
    const outbox = makeOutbox({
      latestSequence: jest.fn().mockResolvedValue(1),
      listSince: jest.fn().mockResolvedValue([
        evt(1, { entityType: 'device', entityVersion: 7, payload: { deviceId: 'd1' } }),
      ]),
    });
    const svc = new SchedulerStreamService(outbox as never);

    const result = await svc.replaySince(0);
    const e = result.events[0];
    expect(e.sequence).toBe(1);
    expect(e.entityType).toBe('device');
    expect(e.entityVersion).toBe(7);
    expect(e.eventId).toBe('evt-1');
  });
});

/* ===== Task 2.2: ImpactAnalyzer 统一异常 + 局部重排 ===== */

describe('ImpactAnalyzer 统一异常分类（Task 2.2.1/2.2.2）', () => {
  const analyzer = new ImpactAnalyzer();

  it('DEVICE_OFFLINE：仅影响使用该设备的待办任务，分类 hard_conflict 且可自动重排', () => {
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't1' }), deviceId: 'd1' },
        { ...seedTask({ id: 't2' }), deviceId: 'd2' },
      ],
    });
    const result = analyzer.analyze(snapshot, { eventType: 'DEVICE_OFFLINE', entityId: 'd1' });
    expect(result.affectedTaskIds).toEqual(['t1']);
    expect(result.affectedTaskIds).not.toContain('t2');
    expect(result.classification).toBe('hard_conflict');
    expect(result.canAutoReplan).toBe(true);
    expect(result.recommendedAction).toBe('replan_partial');
  });

  it('SAFETY_EVENT：关键事件，走 manual_review 且不可自动重排', () => {
    const snapshot = buildSnapshot({
      tasks: [seedTask({ id: 't1', zoneId: 'z-factory' })],
      forbiddenZones: [{ zoneId: 'z-factory', reason: 'safety_event' }],
    });
    const result = analyzer.analyze(snapshot, { eventType: 'SAFETY_EVENT', entityId: 'z-factory' });
    expect(result.affectedTaskIds).toContain('t1');
    expect(result.classification).toBe('critical_event');
    expect(result.canAutoReplan).toBe(false);
    expect(result.recommendedAction).toBe('manual_review');
  });

  it('下游传递：依赖受影响任务的任务被纳入 descendantTaskIds', () => {
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't1' }), deviceId: 'd1' },
        { ...seedTask({ id: 't-dep' }), predecessorIds: ['t1'] },
      ],
    });
    const result = analyzer.analyze(snapshot, { eventType: 'DEVICE_OFFLINE', entityId: 'd1' });
    expect(result.affectedTaskIds).toEqual(expect.arrayContaining(['t1', 't-dep']));
    expect(result.descendantTaskIds).toContain('t-dep');
  });

  it('执行中/锁定任务被冻结，不进入受影响集合', () => {
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't1' }), deviceId: 'd1' },
        { ...seedTask({ id: 't-exec', status: 'executing' }), assigneeId: 'p1', deviceId: 'd1' },
      ],
      lockedAssignments: [{ taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null }],
    });
    const result = analyzer.analyze(snapshot, { eventType: 'DEVICE_OFFLINE', entityId: 'd1' });
    expect(result.affectedTaskIds).not.toContain('t-exec');
    expect(result.frozenTaskIds).toContain('t-exec');
  });
});

describe('ReplanCoordinatorService.handleTrigger 局部重排（Task 2.2.3）', () => {
  function makeReplanService(snapshot: WorldStateSnapshot) {
    const db = {
      update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })) })),
    };
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, fn: () => Promise<void>) => fn()),
    };
    const triggerService = {
      evaluate: jest.fn().mockResolvedValue({
        runId: 'RUN-1',
        triggerType: 'DEVICE_OFFLINE',
        triggerEntityId: 'd1',
        status: 'queued',
        snapshotVersion: null,
        planIds: [],
        orgId: 'org1',
        error: null,
        createdAt: new Date().toISOString(),
      }),
    };
    const worldStateSnapshotService = { buildSnapshot: jest.fn().mockResolvedValue(snapshot) };
    const solverService = {
      solveVariants: jest.fn().mockResolvedValue([
        {
          planId: 'RUN-1A',
          version: 1,
          status: 'shadow',
          trigger: { type: 'DEVICE_OFFLINE', entityId: 'd1' },
          snapshotVersion: 'WS-TEST-0001',
          policyVersion: 1,
          solverVersion: 'heuristic-v2',
          horizonMinutes: 480,
          assignments: [],
          metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
          baselineDelta: {},
          violations: [],
          createdAt: new Date().toISOString(),
        },
      ]),
    };
    const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };

    const svc = new ReplanCoordinatorService(
      db as never,
      requestDatabaseContext as never,
      triggerService as never,
      worldStateSnapshotService as never,
      solverService as never,
      planService as never,
      {} as never,
    );
    return { svc, solverService, planService };
  }

  it('DEVICE_OFFLINE 只把受影响 + 冻结任务交给求解器，无关任务不进入子图（不 churn）', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      devices: [seedDevice({ id: 'd1', online: false }), seedDevice({ id: 'd2' })],
      tasks: [
        { ...seedTask({ id: 't-affected' }), deviceId: 'd1' }, // 受影响
        { ...seedTask({ id: 't-other' }), deviceId: 'd2' },    // 无关
        { ...seedTask({ id: 't-exec', status: 'executing' }), assigneeId: 'p1', deviceId: 'd1' }, // 冻结
      ],
      lockedAssignments: [{ taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null }],
    });
    const { svc, solverService } = makeReplanService(snapshot);

    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    const [partialSnapshot, , opts] = solverService.solveVariants.mock.calls[0];
    // 子图 = 受影响(t-affected) ∪ 冻结(t-exec)；无关任务 t-other 不进入求解输入。
    expect((partialSnapshot as WorldStateSnapshot).tasks.map((t: { id: string }) => t.id).sort()).toEqual(
      ['t-affected', 't-exec'],
    );
    // 传递 baselineAssignee 作为 churn/stability 罚项基线。
    expect(opts.baselineAssignee).toBeInstanceOf(Map);
    expect((opts.baselineAssignee as Map<string, string | null>).get('t-exec')).toBe('p1');
  });

  it('正常路径下 plan 被持久化且运行状态更新', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      devices: [seedDevice({ id: 'd1' })],
      tasks: [{ ...seedTask({ id: 't1' }), deviceId: 'd1' }],
    });
    const { svc, planService } = makeReplanService(snapshot);
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', { userId: 'u1', primaryOrgId: 'org1' });
    expect(planService.persistPlan).toHaveBeenCalled();
  });
});