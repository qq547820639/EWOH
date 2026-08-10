import { ConflictException } from '@nestjs/common';
import { PlanService } from '../plan.service';
import { ShadowPolicyService } from '../shadow-policy.service';

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

  /** 构造 PlanService（db.select 返回给定 planRow；dispatch 委托 dispatchCoordinator mock）。 */
  const makePlanService = (planRow: ReturnType<typeof makePlanRow>) => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve([planRow])),
            // getPlan 的 assignment 查询走 orderBy 分支（返回空分配明细）。
            orderBy: jest.fn(() => Promise.resolve([])),
          })),
        })),
      })),
    } as never;
    const dispatchCoordinator = { dispatch: jest.fn().mockResolvedValue(undefined) };
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
    // 仅替换 dispatch 依赖（经 as never 后的运行时字段）。
    (svc as unknown as { dispatchCoordinator: typeof dispatchCoordinator }).dispatchCoordinator =
      dispatchCoordinator;
    return { svc, dispatchCoordinator };
  };

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

  it('dispatchPlan：持久化 shadow plan（is_shadow=true）被服务端拒绝（SHADOW_PLAN_GUARD）', async () => {
    const { svc, dispatchCoordinator } = makePlanService(makePlanRow(true));
    await expect(
      svc.dispatchPlan('SHADOW-1', {} as never),
    ).rejects.toThrow(/SHADOW_PLAN_GUARD: shadow plan cannot be dispatched/);
    // guard 在委托 dispatch 之前触发：dispatchCoordinator.dispatch 绝不调用。
    expect(dispatchCoordinator.dispatch).not.toHaveBeenCalled();
  });

  it('dispatchPlan：非 shadow plan 放行并委托 dispatch（guard 放行语义）', async () => {
    const { svc, dispatchCoordinator } = makePlanService(makePlanRow(false));
    await svc.dispatchPlan('P-1', {} as never);
    expect(dispatchCoordinator.dispatch).toHaveBeenCalledWith('P-1', {});
  });

  it('guardShadowPlan(reserve)：持久化 shadow plan（is_shadow=true）被服务端拒绝（SHADOW_PLAN_GUARD）', async () => {
    const planRow = makePlanRow(true);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([planRow])) })) })),
      })),
    } as never;
    const svc = new ShadowPolicyService(
      db,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { recordPolicyEvent: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
    );
    await expect(
      svc.guardShadowPlan('SHADOW-1', 'reserve'),
    ).rejects.toThrow(/SHADOW_PLAN_GUARD: shadow plan SHADOW-1 cannot be reserve/);
  });

  it('guardShadowPlan(reserve)：非 shadow plan 放行（不抛）', async () => {
    const planRow = makePlanRow(false);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([planRow])) })) })),
      })),
    } as never;
    const svc = new ShadowPolicyService(
      db,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { recordPolicyEvent: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
    );
    await expect(svc.guardShadowPlan('P-1', 'reserve')).resolves.toBeUndefined();
  });
});
