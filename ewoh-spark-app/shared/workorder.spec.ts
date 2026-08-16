/* WorkOrder 契约行为测试（ADR-012 / NO-05e-a）。
 *
 * 覆盖：契约校验 fail-closed（origin 必填/kind 封闭/completed 必带 completedAt/
 * cancelled 必带 reason/severity 契约）、生命周期顺序强制（in_progress 起不可
 * 取消、closed/cancelled 终态）。共享向量由 scripts/audit-domain-contracts.js
 * 独立仲裁（216/216）。
 */
/// <reference types="jest" />
import {
  validateWorkOrder,
  workOrderTransitionAllowed,
  WORK_ORDER_LIFECYCLE,
} from './workorder';

const BASE = {
  workOrderId: 'wo:9f1c4a0e',
  workOrderType: 'maintenance',
  origin: { kind: 'maintenance_condition', id: 'mc:1' },
  subjectEntityId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  severity: 'high',
  status: 'created',
};

describe('workorder contract', () => {
  it('合法记录校验通过（maintenance/quality_rework/inspection 三类型）', () => {
    expect(validateWorkOrder(BASE)).toEqual([]);
    expect(
      validateWorkOrder({
        ...BASE,
        workOrderType: 'quality_rework',
        origin: { kind: 'quality_finding', id: 'qf:1' },
        subjectEntityId: 'station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
      }),
    ).toEqual([]);
    expect(validateWorkOrder({ ...BASE, workOrderType: 'inspection' })).toEqual([]);
  });

  it('origin 缺失/kind 非法 → fail-closed 拒绝', () => {
    // origin 键存在但值非法 → missing_origin；键完全缺失 → missing_field:origin
    expect(validateWorkOrder({ ...BASE, origin: undefined })).toEqual([
      'missing_origin',
    ]);
    const { origin: _drop, ...withoutOrigin } = BASE;
    expect(validateWorkOrder(withoutOrigin)).toEqual(['missing_field:origin']);
    expect(
      validateWorkOrder({ ...BASE, origin: { kind: 'schedule_task', id: 't1' } }),
    ).toEqual(['unknown_origin_kind']);
  });

  it('completed 必须带 completedAt；cancelled 必须带 cancelledReason', () => {
    expect(validateWorkOrder({ ...BASE, status: 'completed' })).toEqual([
      'completed_at_required',
    ]);
    expect(validateWorkOrder({ ...BASE, status: 'cancelled' })).toEqual([
      'cancelled_reason_required',
    ]);
    expect(
      validateWorkOrder({ ...BASE, status: 'completed', completedAt: '2026-08-16T12:00:00Z' }),
    ).toEqual([]);
    expect(
      validateWorkOrder({ ...BASE, status: 'cancelled', cancelledReason: 'false_alarm' }),
    ).toEqual([]);
  });

  it('生命周期：in_progress 起不可取消；终态不可转移', () => {
    expect(workOrderTransitionAllowed('created', 'scheduled')).toBe(true);
    expect(workOrderTransitionAllowed('in_progress', 'cancelled')).toBe(false);
    expect(workOrderTransitionAllowed('completed', 'cancelled')).toBe(false);
    expect(workOrderTransitionAllowed('closed', 'created')).toBe(false);
    expect(workOrderTransitionAllowed('created', 'completed')).toBe(false);
  });

  it('生命周期注册表与 schema 顺序一致（六态）', () => {
    expect(WORK_ORDER_LIFECYCLE).toEqual([
      'created', 'scheduled', 'in_progress', 'completed', 'closed', 'cancelled',
    ]);
  });

  it('legacy L1 严重度接受（归一化到 critical）', () => {
    expect(validateWorkOrder({ ...BASE, severity: 'L1' })).toEqual([]);
    expect(validateWorkOrder({ ...BASE, severity: 'apocalyptic' })).toEqual([
      'unknown_severity',
    ]);
  });
});
