/* Alert/Andon 处置状态机测试（ADR-031 / §6 Andon Loop）。
 *
 * 覆盖：alert.yaml 转移表逐条（open→acknowledged→processing→closed；
 * closed→reopened；reopened→acknowledged/processing）、action 语义映射、
 * 角色条件机器执行（reopen 仅 safety_admin）、非法转移拒绝。
 */
/// <reference types="jest" />
import {
  alertStateTransitionAllowed,
  alertActionToState,
  ALERT_STATES,
} from './alert-state-machine';

describe('alertStateTransitionAllowed（ADR-031 alert.yaml 单一事实源）', () => {
  it('正向链：open→acknowledged→processing→closed', () => {
    expect(alertStateTransitionAllowed('open', 'acknowledged', 'dispatcher')).toBe(true);
    expect(alertStateTransitionAllowed('acknowledged', 'processing', 'workshop_lead')).toBe(true);
    expect(alertStateTransitionAllowed('processing', 'closed', 'device_ops')).toBe(true);
  });

  it('复开：closed→reopened 仅 safety_admin（角色条件机器执行）', () => {
    expect(alertStateTransitionAllowed('closed', 'reopened', 'safety_admin')).toBe(true);
    expect(alertStateTransitionAllowed('closed', 'reopened', 'dispatcher')).toBe(false);
    expect(alertStateTransitionAllowed('closed', 'reopened', undefined)).toBe(false);
  });

  it('reopened→acknowledged/processing（handler 任一处置角色）', () => {
    expect(alertStateTransitionAllowed('reopened', 'acknowledged', 'workshop_lead')).toBe(true);
    expect(alertStateTransitionAllowed('reopened', 'processing', 'dispatcher')).toBe(true);
  });

  it('非法转移拒绝（跳过/回退）', () => {
    expect(alertStateTransitionAllowed('open', 'closed', 'dispatcher')).toBe(false);
    expect(alertStateTransitionAllowed('processing', 'acknowledged', 'dispatcher')).toBe(false);
    expect(alertStateTransitionAllowed('closed', 'acknowledged', 'dispatcher')).toBe(false);
  });

  it('状态注册表 5 态', () => {
    expect(ALERT_STATES).toEqual(['open', 'acknowledged', 'processing', 'closed', 'reopened']);
  });
});

describe('alertActionToState（action 语义映射，alert/andon 双面复用）', () => {
  it('acknowledge/process/close/reopen 映射', () => {
    expect(alertActionToState('acknowledge')).toEqual({ to: 'acknowledged' });
    expect(alertActionToState('process')).toEqual({ to: 'processing' });
    expect(alertActionToState('close')).toEqual({ to: 'closed' });
    expect(alertActionToState('reopen')).toEqual({ to: 'reopened' });
    expect(alertActionToState('gizmo')).toBeNull();
  });
});
