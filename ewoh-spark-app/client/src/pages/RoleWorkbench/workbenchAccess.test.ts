import {
  canUseWorkbenchDebug,
  resolveAuthorizedWorkbenchRoles,
  resolveDefaultWorkbenchRole,
} from './workbenchAccess';

describe('workbenchAccess (TR-9.2 默认角色来自认证用户)', () => {
  it('defaults an ordinary worker to operator, never manager', () => {
    expect(resolveDefaultWorkbenchRole(['worker'])).toBe('operator');
  });

  it('defaults device_ops to equipment and safety_admin to quality', () => {
    expect(resolveDefaultWorkbenchRole(['device_ops'])).toBe('equipment');
    expect(resolveDefaultWorkbenchRole(['safety_admin'])).toBe('quality');
  });

  it('defaults workshop_lead to team_lead', () => {
    expect(resolveDefaultWorkbenchRole(['workshop_lead'])).toBe('team_lead');
  });

  it('only defaults to manager for a global_admin', () => {
    expect(resolveDefaultWorkbenchRole(['global_admin'])).toBe('manager');
  });

  it('falls back to operator when no auth role is known', () => {
    expect(resolveDefaultWorkbenchRole([])).toBe('operator');
  });

  it('a plain worker only sees the operator tab', () => {
    expect(resolveAuthorizedWorkbenchRoles(['worker'])).toEqual(['operator']);
  });

  it('a global_admin sees every workbench role', () => {
    expect(resolveAuthorizedWorkbenchRoles(['global_admin'])).toEqual([
      'operator',
      'team_lead',
      'quality',
      'equipment',
      'manager',
    ]);
  });

  it('debug is only granted to admin server roles, not any user', () => {
    expect(canUseWorkbenchDebug(['worker'])).toBe(false);
    expect(canUseWorkbenchDebug(['workshop_lead'])).toBe(false);
    expect(canUseWorkbenchDebug(['global_admin'])).toBe(true);
  });
});