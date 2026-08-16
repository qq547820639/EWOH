/* ExoSession 契约测试（ADR-032 / §7：外骨骼↔人员绑定 Session）。
 *
 * 覆盖：status 封闭注册表（未知拒绝）、规范身份（device:/person: 前缀）、
 * 结束事实完整（ended/aborted 必须 actualEndAt + endedBy）、时间不倒退、
 * active 不允许 actualEndAt、auditTrail、状态机终态不可复开。
 */
/// <reference types="jest" />
import { validateExoSession, exoSessionTransitionAllowed } from './exo-session';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'exo-session:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    exoId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    personId: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    status: 'active',
    startedAt: '2026-08-16T08:00:00Z',
    auditTrail: true,
    ...overrides,
  };
}

describe('validateExoSession（ADR-032 契约）', () => {
  it('合法 active / ended / aborted 通过', () => {
    expect(validateExoSession(record())).toEqual([]);
    expect(
      validateExoSession(
        record({ status: 'ended', actualEndAt: '2026-08-16T10:00:00Z', endedBy: 'person:op1' }),
      ),
    ).toEqual([]);
    expect(
      validateExoSession(
        record({ status: 'aborted', actualEndAt: '2026-08-16T08:30:00Z', endedBy: 'person:op1', reason: '设备故障' }),
      ),
    ).toEqual([]);
  });

  it('非规范身份拒绝（§7 + ADR-006）', () => {
    expect(validateExoSession(record({ exoId: 'EXO-001' }))[0]).toBe('bad_exo_identity');
    expect(validateExoSession(record({ personId: 'P-001' }))[0]).toBe('bad_person_identity');
  });

  it('结束事实完整：ended 缺 actualEndAt/endedBy 拒绝（§33 不悬空）', () => {
    expect(validateExoSession(record({ status: 'ended', endedBy: 'person:op1' }))[0]).toBe('actual_end_required');
    expect(
      validateExoSession(record({ status: 'ended', actualEndAt: '2026-08-16T10:00:00Z' }))[0],
    ).toBe('ended_by_required');
  });

  it('时间不倒退 + active 不允许 actualEndAt', () => {
    expect(
      validateExoSession(
        record({ status: 'ended', startedAt: '2026-08-16T10:00:00Z', actualEndAt: '2026-08-16T08:00:00Z', endedBy: 'person:op1' }),
      )[0],
    ).toBe('bad_time_order');
    expect(
      validateExoSession(record({ actualEndAt: '2026-08-16T09:00:00Z' }))[0],
    ).toBe('actual_end_not_allowed');
  });

  it('未知 status 与 auditTrail=false 拒绝', () => {
    expect(validateExoSession(record({ status: 'paused' }))[0]).toBe('unknown_status');
    expect(validateExoSession(record({ auditTrail: false }))[0]).toBe('audit_required');
  });
});

describe('exoSessionTransitionAllowed（ADR-032 状态机）', () => {
  it('active→ended/aborted；终态不可复开', () => {
    expect(exoSessionTransitionAllowed('active', 'ended')).toBe(true);
    expect(exoSessionTransitionAllowed('active', 'aborted')).toBe(true);
    expect(exoSessionTransitionAllowed('ended', 'active')).toBe(false);
    expect(exoSessionTransitionAllowed('aborted', 'active')).toBe(false);
    expect(exoSessionTransitionAllowed('active', 'active')).toBe(false);
  });
});
