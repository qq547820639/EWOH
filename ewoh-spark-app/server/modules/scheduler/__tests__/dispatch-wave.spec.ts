import { makeDispatchCoordinator, testOrgContext } from './dispatch-test-harness';

/**
 * 分波次派工（部分执行）回归。
 *
 * 业务动机：班组长审批了 3 条任务的方案，但当前只有 1 组资源可用。
 * 旧行为是全有或全无——全派会因资源冲突整单 409，全不派则现场停工。
 *
 * 三条不变量（本文件把它们钉死）：
 *  1. **波内全有或全无**：波内出现不可派工项即拒绝整波，绝不半应用；
 *  2. **计划状态不得伪装**：只有本波覆盖全部待派工项时才进入契约终态
 *     `dispatched`（语义是"全部转任务"）；部分派工时保持 `approved`，
 *     并通过 `remainingAssignmentIds` 显式暴露剩余；
 *  3. 已派工的波不因后续波失败而丢失（剩余仍是 approved，可继续派）。
 *
 * 测试替身保真度记录（2026-09-10 发现）：`dispatch-test-harness` 的假 DB 对
 * assignment 的 `where(status = 'approved')` **不生效**——第二轮波次曾把已派工
 * 的行也当成待派工，导致"分两波派完"用例失败。生产 SQL 会正确过滤，因此这是
 * 替身保真度问题而非产品缺陷；但依赖替身过滤的断言会失真。
 * 处置：派工协调器改为**取回本方案全部 assignment 后在代码里显式分区**
 * （见 dispatch-coordinator「显式分区」注释），使波次边界不再依赖 SQL 谓词构造，
 * 本文件因此能在真假两种实现下都验证真实语义。
 */
function approvedPlan() {
  return {
    plans: [{
      id: 'plan-row-1',
      planId: 'PLAN-WAVE',
      orgId: 'org-1',
      status: 'approved',
      isShadow: false,
      snapshotVersion: 'WS-1',
      createdBy: 'planner-1',
    }],
  };
}

function assignment(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `asg-row-${n}`,
    assignmentId: `ASG-${n}`,
    planId: 'PLAN-WAVE',
    taskId: `TASK-${n}`,
    orgId: 'org-1',
    personId: `p${n}`,
    deviceId: null,
    stationId: `s${n}`,
    status: 'approved',
    version: 1,
    plannedStart: new Date('2026-09-11T08:00:00.000Z'),
    plannedEnd: new Date('2026-09-11T09:00:00.000Z'),
    etaSeconds: 60,
    ...over,
  };
}

function seedThree() {
  return {
    ...approvedPlan(),
    assignments: [assignment(1), assignment(2), assignment(3)],
    tasks: [
      { id: 'TASK-1', status: 'pending_dispatch', version: 1 },
      { id: 'TASK-2', status: 'pending_dispatch', version: 1 },
      { id: 'TASK-3', status: 'pending_dispatch', version: 1 },
    ],
  };
}

describe('分波次派工（部分执行）', () => {
  it('整单派工（不传波次）：全部派完并进入契约终态 dispatched', async () => {
    const { svc, state } = makeDispatchCoordinator(seedThree());
    const result = await svc.dispatch('PLAN-WAVE', testOrgContext());
    expect(result.dispatchedAssignments).toBe(3);
    expect(result.planStatus).toBe('dispatched');
    expect(result.remainingAssignmentIds).toEqual([]);
    expect(result.remainingAssignments).toBe(0);
    // 计划行确实落到终态
    expect(state.plans.get('PLAN-WAVE')?.status).toBe('dispatched');
    // 全部 assignment 已派工
    expect(state.assignments.every((a) => a.status === 'dispatched')).toBe(true);
  });

  it('只派一波：计划保持 approved（不得伪装成终态），剩余显式回传', async () => {
    const { svc, state } = makeDispatchCoordinator(seedThree());
    const result = await svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-2'] });

    expect(result.dispatchedAssignmentIds).toEqual(['ASG-2']);
    expect(result.dispatchedAssignments).toBe(1);
    // 关键：计划**不得**变成 dispatched（dispatched 是终态，语义为全部转任务）
    expect(result.planStatus).toBe('approved');
    expect(state.plans.get('PLAN-WAVE')?.status).toBe('approved');
    // 剩余两项显式可见
    expect(result.remainingAssignments).toBe(2);
    expect([...(result.remainingAssignmentIds ?? [])].sort()).toEqual(['ASG-1', 'ASG-3']);
    // 已派工项与剩余项在库内状态正确区分
    const byId = new Map(state.assignments.map((a) => [a.assignmentId, a.status]));
    expect(byId.get('ASG-2')).toBe('dispatched');
    expect(byId.get('ASG-1')).toBe('approved');
    expect(byId.get('ASG-3')).toBe('approved');
  });

  it('分两波派完：最后一波才进入 dispatched 终态', async () => {
    const { svc, state } = makeDispatchCoordinator(seedThree());
    const first = await svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-1', 'ASG-2'] });
    expect(first.planStatus).toBe('approved');
    expect(first.remainingAssignments).toBe(1);
    expect(state.plans.get('PLAN-WAVE')?.status).toBe('approved');

    const second = await svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-3'] });
    expect(second.dispatchedAssignmentIds).toEqual(['ASG-3']);
    expect(second.planStatus).toBe('dispatched');
    expect(second.remainingAssignments).toBe(0);
    expect(state.plans.get('PLAN-WAVE')?.status).toBe('dispatched');
  });

  it('波内全有或全无：含已派工项 → 拒绝整波，且不产生任何副作用', async () => {
    const { svc, state, mocks } = makeDispatchCoordinator({
      ...seedThree(),
      // ASG-2 已被上一波派工（不在 approved 待派工集合内）
      assignments: [assignment(1), assignment(2, { status: 'dispatched' }), assignment(3)],
    });
    await expect(
      svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-1', 'ASG-2'] }),
    ).rejects.toThrow(/DISPATCH_WAVE_INVALID/);

    // 无半应用：ASG-1 仍待派工，计划仍 approved，未产生 outbox/预占
    const byId = new Map(state.assignments.map((a) => [a.assignmentId, a.status]));
    expect(byId.get('ASG-1')).toBe('approved');
    expect(byId.get('ASG-3')).toBe('approved');
    expect(state.plans.get('PLAN-WAVE')?.status).toBe('approved');
    expect(mocks.reservationService.reserve).not.toHaveBeenCalled();
    expect(mocks.outboxService.enqueue).not.toHaveBeenCalled();
  });

  it('波内包含不存在/他方案的 assignment → 拒绝并列出问题项', async () => {
    const { svc } = makeDispatchCoordinator(seedThree());
    await expect(
      svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-1', 'ASG-NOT-MINE'] }),
    ).rejects.toThrow(/DISPATCH_WAVE_INVALID[\s\S]*ASG-NOT-MINE/);
  });

  it('空数组等价于未指定波次 = 整单派工（控制器层已归一，故此层不视为错误）', async () => {
    const { svc } = makeDispatchCoordinator(seedThree());
    await expect(
      svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: [] }),
    ).resolves.toMatchObject({ dispatchedAssignments: 3, planStatus: 'dispatched' });
  });

  it('全部待派工项都已派工后再派工 → 明确冲突，不假装成功', async () => {
    const { svc } = makeDispatchCoordinator({
      ...approvedPlan(),
      assignments: [assignment(1, { status: 'dispatched' })],
      tasks: [{ id: 'TASK-1', status: 'dispatched', version: 1 }],
    });
    await expect(
      svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-1'] }),
    ).rejects.toThrow(/DISPATCH_WAVE_INVALID/);
  });

  it('非 approved 方案不可派工（保持既有守卫）', async () => {
    const { svc } = makeDispatchCoordinator({
      ...seedThree(),
      plans: [{ ...approvedPlan().plans[0], status: 'shadow' }],
    });
    await expect(svc.dispatch('PLAN-WAVE', testOrgContext()))
      .rejects.toThrow(/PLAN_NOT_APPROVED/);
  });

  it('部分派工只预占本波资源（不为剩余项占位）', async () => {
    const { svc, mocks } = makeDispatchCoordinator(seedThree());
    await svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-2'] });
    const reserveCalls = (mocks.reservationService.reserve as jest.Mock).mock.calls;
    // 预占调用里出现的 assignment 只应是本波（ASG-2）
    const serialized = JSON.stringify(reserveCalls);
    expect(serialized).toContain('ASG-2');
    expect(serialized).not.toContain('ASG-1');
    expect(serialized).not.toContain('ASG-3');
  });

  /**
   * 自查修正（2026-09-13）回归：事务前的 fail-fast 预检（安全熔断/外骨骼会话/
   * ADVISORY 降级/工位容量）原按**全方案** approved 集合判定，而事务内权威复查
   * 与实际预占只作用于本波。全方案口径会让"他波的冲突"挡住"本波的合法派工"
   * （实测路径：波 2 的人员被安全阻断 → 波 1 派工 409 SAFETY_BLOCK_DISPATCH）。
   * 预检作用域必须收敛到本波。
   */
  it('波次预检作用域：他波命中的安全阻断不挡本波派工', async () => {
    const { svc, mocks } = makeDispatchCoordinator(seedThree());
    // 只有他波的 ASG-2（p2）被安全事件阻断；本波只派 ASG-1（p1，无阻断）。
    mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
      safetyBlockedPersonIds: ['p2'],
      safetyBlockedDeviceIds: [],
      devices: [],
      stations: [],
    });
    const result = await svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-1'] });
    expect(result.dispatchedAssignmentIds).toEqual(['ASG-1']);
    expect(result.planStatus).toBe('approved');
  });

  it('波内命中安全阻断仍整波拒绝（作用域收敛不放松护栏）', async () => {
    const { svc, mocks } = makeDispatchCoordinator(seedThree());
    mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
      safetyBlockedPersonIds: ['p1'],
      safetyBlockedDeviceIds: [],
      devices: [],
      stations: [],
    });
    await expect(
      svc.dispatch('PLAN-WAVE', testOrgContext(), { assignmentIds: ['ASG-1'] }),
    ).rejects.toThrow(/SAFETY_BLOCK_DISPATCH/);
  });
});
