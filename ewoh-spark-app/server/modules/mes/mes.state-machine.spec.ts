/* MES 状态机 ↔ ADR-012 契约对齐测试（NEST-322/323，2026-08-17 审计整改）。
 *
 * 事实源 = shared/workorder.ts（contracts/workorder 的 TS 消费面）。MES 的
 * draft/released 是 created/scheduled 的显式 alias；本测试把 alias 双射与
 * 全部 (状态, 动作) 组合钉死在契约语义上——漂移（改 shared/workorder.ts
 * 或改 mes 状态机任一侧）在此显式暴露。
 */
/// <reference types="jest" />
import {
  nextWorkOrderStatus,
  nextStepStatus,
  MES_WORK_ORDER_STATUS_TO_CONTRACT,
  CONTRACT_WORK_ORDER_STATUS_TO_MES,
} from './mes.service';
import {
  workOrderTransitionAllowed,
  WORK_ORDER_LIFECYCLE,
} from '@shared/workorder';

describe('MES 工单状态机 ↔ ADR-012 alias 对齐', () => {
  it('MES 状态词表与 ADR-012 生命周期子集一一对应（alias 双射）', () => {
    const mesStatuses = Object.keys(MES_WORK_ORDER_STATUS_TO_CONTRACT);
    // MES 无 closed（闭环收口在 completed），其余契约生命周期状态全覆盖。
    expect([...mesStatuses].sort()).toEqual(
      ['cancelled', 'completed', 'draft', 'in_progress', 'released'].sort(),
    );
    for (const [mes, canonical] of Object.entries(MES_WORK_ORDER_STATUS_TO_CONTRACT)) {
      expect(WORK_ORDER_LIFECYCLE).toContain(canonical);
      expect(CONTRACT_WORK_ORDER_STATUS_TO_MES[canonical]).toBe(mes);
    }
  });

  it('每个允许的 MES 转移都对应一条合法契约转移（无契约外漂移）', () => {
    const actions = ['release', 'start', 'complete', 'cancel'];
    const allowed: Array<[string, string, string]> = [];
    for (const status of Object.keys(MES_WORK_ORDER_STATUS_TO_CONTRACT)) {
      for (const action of actions) {
        const next = nextWorkOrderStatus(status, action);
        if (next !== null) {
          allowed.push([status, action, next]);
        }
      }
    }
    // 现行契约语义快照（钉死）：
    expect(allowed).toEqual([
      ['draft', 'release', 'released'],
      ['draft', 'cancel', 'cancelled'],
      ['released', 'start', 'in_progress'],
      ['released', 'cancel', 'cancelled'],
      ['in_progress', 'complete', 'completed'],
    ]);
    for (const [from, , to] of allowed) {
      expect(
        workOrderTransitionAllowed(
          MES_WORK_ORDER_STATUS_TO_CONTRACT[from]!,
          MES_WORK_ORDER_STATUS_TO_CONTRACT[to]!,
        ),
      ).toBe(true);
    }
  });

  it('契约不允许的转移在 MES 侧一律拒绝（fail-closed）', () => {
    // created→in_progress（跳过 scheduled）不可；in_progress→cancelled 不可；
    // completed→任何 不可。
    expect(nextWorkOrderStatus('draft', 'start')).toBeNull();
    expect(nextWorkOrderStatus('in_progress', 'cancel')).toBeNull();
    expect(nextWorkOrderStatus('completed', 'release')).toBeNull();
    expect(nextWorkOrderStatus('completed', 'cancel')).toBeNull();
    expect(nextWorkOrderStatus('released', 'release')).toBeNull();
    expect(nextWorkOrderStatus('draft', 'complete')).toBeNull();
    expect(nextWorkOrderStatus('teleport', 'release')).toBeNull();
    expect(nextWorkOrderStatus('draft', 'teleport')).toBeNull();
  });
});

describe('MES 工序状态机（无契约对应面，行为钉死）', () => {
  it('现行工序转移表钉死（contracts/state-machines 无工序级 yaml）', () => {
    expect(nextStepStatus('pending', 'start')).toBe('in_progress');
    expect(nextStepStatus('in_progress', 'report')).toBe('reported');
    expect(nextStepStatus('reported', 'review')).toBe('reviewed');
    expect(nextStepStatus('reviewed', 'handover')).toBe('handed_over');
    expect(nextStepStatus('in_progress', 'pause')).toBe('paused');
    expect(nextStepStatus('paused', 'resume')).toBe('in_progress');
    expect(nextStepStatus('pending', 'cancel')).toBe('cancelled');
    // 非法转移
    expect(nextStepStatus('pending', 'report')).toBeNull();
    expect(nextStepStatus('handed_over', 'start')).toBeNull();
    expect(nextStepStatus('cancelled', 'resume')).toBeNull();
    expect(nextStepStatus('in_progress', 'handover')).toBeNull();
  });
});
