/* P0-2 约束生命周期测试：replan 继承持久化人工约束；查询/解除/审计。
 *
 * 核心断言：人工 LOCK 不得因为下一次普通 replan 传入 [] 而消失。
 */
/// <reference types="jest" />
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';
import { PlanService } from '../plan.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { AuditService } from '@server/modules/shared/audit.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { SolverService } from '../solver.service';
import { DispatchCoordinatorService } from '../dispatch-coordinator.service';

function makePlanService(seed: Parameters<typeof makeFakeDb>[0]) {
  const { db, state } = makeFakeDb(seed);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const worldState = { buildSnapshot: jest.fn(), getCurrentWorldState: jest.fn() };
  const policy = { getActivePolicy: jest.fn(), getPolicy: jest.fn(), getConfig: jest.fn(), getConfigByVersion: jest.fn() };
  const feedback = { deriveKpis: jest.fn() };
  const solver = { solve: jest.fn(), solveVariants: jest.fn() };
  const dispatch = { dispatch: jest.fn() };

  const svc = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solver as unknown as SolverService,
    worldState as unknown as WorldStateSnapshotService,
    dispatch as unknown as DispatchCoordinatorService,
    policy as unknown as SchedulingPolicyService,
    feedback as unknown as SchedulingFeedbackService,
  );
  return { svc, state, db, mocks: { worldState, solver, auditService } };
}

function constraintRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cid-1',
    constraintId: 'CON-1',
    planId: 'PLAN-1',
    taskId: 't1',
    type: 'LOCKED_PERSON',
    valueJson: { personId: 'p1', operator: 'leader1', reason: '人工锁定', snapshotVersion: 'WS-1' },
    active: true,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('P0-2 约束生命周期', () => {
  it('listPlanConstraints 返回持久化人工约束（含 valueJson 反序列化）', async () => {
    const { svc } = makePlanService({
      constraints: [constraintRow()],
    });
    // mock 的 where 不实现过滤（active 过滤由真实 SQL where 完成），
    // 此处验证反序列化正确性：personId/operator/type 从 valueJson 恢复。
    const constraints = await svc.listPlanConstraints('PLAN-1');
    expect(constraints).toHaveLength(1);
    expect(constraints[0].id).toBe('CON-1');
    expect(constraints[0].personId).toBe('p1');
    expect(constraints[0].operator).toBe('leader1');
    expect(constraints[0].type).toBe('LOCKED_PERSON');
  });

  it('loadEffectiveConstraints 合并继承约束与请求约束（人工 LOCK 不因 replan [] 丢失）', async () => {
    const { svc } = makePlanService({
      constraints: [constraintRow({ constraintId: 'CON-LOCK', planId: 'PLAN-1' })],
    });
    // 普通 replan 传入空约束 → 仍继承 CON-LOCK
    const effective = await svc.loadEffectiveConstraints('PLAN-1', []);
    expect(effective).toHaveLength(1);
    expect(effective[0].id).toBe('CON-LOCK');
    expect(effective[0].type).toBe('LOCKED_PERSON');

    // 请求传入新约束 → 合并
    const effective2 = await svc.loadEffectiveConstraints('PLAN-1', [
      { type: 'EXCLUDED_RESOURCE', deviceId: 'd9' },
    ] as never);
    expect(effective2).toHaveLength(2);
  });

  it('deactivateConstraint 写审计 + schedule_audit 记录（软删除由真实 DB update 生效）', async () => {
    const { svc, state, mocks } = makePlanService({
      constraints: [constraintRow({ constraintId: 'CON-1', planId: 'PLAN-1' })],
    });
    const ctx = testOrgContext();

    await svc.deactivateConstraint('CON-1', ctx, '任务已变更');

    // 审计日志（appendAuditLog）必须记录解除动作
    expect(mocks.auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scheduler.constraint.deactivate',
        entityId: 'CON-1',
        before: { active: true },
        after: { active: false },
      }),
    );
    // schedule_audit 行也必须写入（ewoh_schedule_audit）
    const auditRows = state.audits.filter((a) => a.action === 'constraint.deactivate');
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('deactivateConstraint 不存在时抛 NotFound', async () => {
    const { svc } = makePlanService({ constraints: [] });
    await expect(svc.deactivateConstraint('NOPE', testOrgContext())).rejects.toThrow('not found');
  });
});
