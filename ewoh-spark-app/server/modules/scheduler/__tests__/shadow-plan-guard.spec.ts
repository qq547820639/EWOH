import { ConflictException } from '@nestjs/common';
import { PlanService } from '../plan.service';

describe('Shadow Plan Guard（P4-SHADOW：服务端 hard guard）', () => {
  const makePlanRow = (isShadow: boolean) => ({
    id: 'id-1',
    planId: 'SHADOW-1',
    planName: 'shadow-v2',
    strategy: 'scheduling_v2',
    status: 'proposed',
    version: 1,
    snapshotVersion: 'WS-1',
    triggerType: 'MANUAL',
    triggerEntityId: null,
    metricsJson: null,
    baselineDeltaJson: null,
    violationsJson: null,
    policyVersion: 2,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    scoreBreakdownJson: null,
    weightsJson: null,
    isShadow,
    shadowPolicyVersion: isShadow ? 2 : null,
    isSimulation: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('approvePlan：shadow plan 被服务端拒绝（SHADOW_PLAN_GUARD）', async () => {
    const planRow = makePlanRow(true);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([planRow])) })) })),
      })),
    } as never;
    const svc = new PlanService(
      db,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { recordAcceptance: jest.fn(), recordBaseline: jest.fn() } as never,
      { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue({ id: 'evt', eventType: 'stale_plan', entityId: 'x', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() }) } as never,
      { handleTrigger: jest.fn() } as never,
    );
    await expect(
      svc.approvePlan('SHADOW-1', { version: 1, snapshotVersion: 'WS-1', operator: 'admin' }, {} as never),
    ).rejects.toThrow(ConflictException);
    await expect(
      svc.approvePlan('SHADOW-1', { version: 1, snapshotVersion: 'WS-1', operator: 'admin' }, {} as never),
    ).rejects.toThrow(/SHADOW_PLAN_GUARD/);
  });

  it('approvePlan：非 shadow plan 正常放行（进入版本/快照校验）', async () => {
    const planRow = makePlanRow(false);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([planRow])) })) })),
      })),
    } as never;
    const svc = new PlanService(
      db,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { recordAcceptance: jest.fn(), recordBaseline: jest.fn() } as never,
      { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue({ id: 'evt', eventType: 'stale_plan', entityId: 'x', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() }) } as never,
      { handleTrigger: jest.fn() } as never,
    );
    // 版本不匹配 → 抛 PLAN_STALE（证明 guard 放行且进入后续校验）
    await expect(
      svc.approvePlan('P-1', { version: 999, snapshotVersion: 'WS-1', operator: 'admin' }, {} as never),
    ).rejects.toThrow('PLAN_STALE');
  });
});
