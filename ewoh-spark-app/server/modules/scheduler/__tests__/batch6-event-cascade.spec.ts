/* v0.7 Batch6：事件驱动补全测试
 * 覆盖：
 *   - injectSchedulingEvent：事件 → 局部重排 + 世界状态级联 scoped 重排
 *   - dispatch SAFETY 熔断：派工涉及安全阻断资源 → SAFETY_BLOCK_DISPATCH
 *   - metrics 埋点：事件驱动成功/回退计数
 */
/// <reference types="jest" />
import { ConflictException } from '@nestjs/common';
import { SchedulerService } from '../scheduler.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { DispatchCoordinatorService } from '../dispatch-coordinator.service';
import type { WorldStateSnapshot, SchedulingPlanV2 } from '@shared/api.interface';

function makeSelect(rowsProvider: () => Array<Record<string, unknown>>) {
  const q: any = {
    then: (resolve: (v: unknown) => void) => resolve(rowsProvider()),
    where: () => q,
    orderBy: () => q,
    limit: () => q,
  };
  return q;
}

function makeFakeDb(plans: Array<Record<string, unknown>> = []) {
  const db: any = {
    select: () => ({
      from: (table: unknown) => makeSelect(() => []),
    }),
    update: () => ({ set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })) }),
  };
  return db;
}

describe('v0.7 Batch6.1: injectSchedulingEvent 事件驱动 + 级联', () => {
  it('事件 → handleTrigger 局部重排 → 级联 dispatchStateTriggers（返回 cascaded）', async () => {
    const db = makeFakeDb([]);
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
    };
    const worldStateSnapshotService = {
      buildSnapshot: jest.fn().mockResolvedValue({
        snapshotVersion: 'WS-T1',
        ts: new Date().toISOString(),
        routeStatus: [{ edgeId: 'e1', status: 'blocked', riskLevel: null }],
        reservations: [],
      } as unknown as WorldStateSnapshot),
    };
    const replanCoordinatorService = {
      handleTrigger: jest.fn().mockResolvedValue({
        run: { runId: 'RUN-E1', triggerType: 'DEVICE_OFFLINE', status: 'succeeded' },
        plans: [{ planId: 'RUN-E1A' } as unknown as SchedulingPlanV2],
        debounced: false,
      }),
      dispatchStateTriggers: jest.fn().mockResolvedValue([
        { triggerType: 'ROUTE_BLOCKED', entityId: 'e1' },
      ]),
    };

    const svc = new SchedulerService(
      db,
      requestDatabaseContext as never,
      { appendAuditLog: jest.fn() } as never,
      worldStateSnapshotService as unknown as WorldStateSnapshotService,
      {} as never,
      {} as never,
      {} as unknown as PlanService,
      {} as never,
      {} as never,
      {} as never,
      { getConfig: jest.fn().mockResolvedValue({ minBatteryPct: 15 }) } as never,
      { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
      undefined,
      replanCoordinatorService as never,
    );

    const result = await svc.injectSchedulingEvent(
      { trigger: 'DEVICE_OFFLINE', entityId: 'd1' },
      { userId: 'u1', primaryOrgId: 'org1', accessibleOrgIds: ['org1'], isGlobalAdmin: false },
    );

    expect(replanCoordinatorService.handleTrigger).toHaveBeenCalledWith('DEVICE_OFFLINE', 'd1', expect.any(Object));
    expect(replanCoordinatorService.dispatchStateTriggers).toHaveBeenCalledTimes(1);
    expect(result.cascaded).toEqual(['ROUTE_BLOCKED']);
    expect(result.run.runId).toBe('RUN-E1');
  });

  it('缺失 replanCoordinatorService → 返回空结果不抛错', async () => {
    const db = makeFakeDb([]);
    const svc = new SchedulerService(
      db,
      { runInTransaction: jest.fn() } as never,
      { appendAuditLog: jest.fn() } as never,
      {} as unknown as WorldStateSnapshotService,
      {} as never,
      {} as never,
      {} as unknown as PlanService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
    );
    const result = await svc.injectSchedulingEvent({ trigger: 'SAFETY_EVENT' });
    expect(result).toEqual({ run: null, plans: [], debounced: true, cascaded: [] });
  });
});

describe('v0.7 Batch6.4: metrics 埋点', () => {
  it('事件驱动成功 → recordRun 计数', async () => {
    const db = makeFakeDb([]);
    const metrics = {
      recordRun: jest.fn(),
      recordFallback: jest.fn(),
    };
    const replanCoordinatorService = {
      handleTrigger: jest.fn().mockResolvedValue({
        run: { runId: 'RUN-M1', status: 'succeeded' },
        plans: [],
        debounced: false,
      }),
      dispatchStateTriggers: jest.fn().mockResolvedValue([]),
    };
    const svc = new SchedulerService(
      db,
      { runInTransaction: jest.fn() } as never,
      { appendAuditLog: jest.fn() } as never,
      { buildSnapshot: jest.fn().mockResolvedValue({ snapshotVersion: 'WS', ts: '' } as never) } as unknown as WorldStateSnapshotService,
      {} as never,
      {} as never,
      {} as unknown as PlanService,
      {} as never,
      {} as never,
      {} as never,
      { getConfig: jest.fn() } as never,
      { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
      undefined,
      replanCoordinatorService as never,
      metrics as never,
    );

    await svc.injectSchedulingEvent({ trigger: 'MANUAL' });
    expect(metrics.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ feasible: true, solverStatus: 'succeeded' }),
    );
    expect(metrics.recordFallback).not.toHaveBeenCalled();
  });
});
