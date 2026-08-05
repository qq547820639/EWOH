import type { RoleWorkbenchRole } from '../../api/operations';

/**
 * Role Workbench access helpers (client-side mirror of the server policy in
 * server/modules/operations/workbench-access.ts).
 *
 * The server remains the SINGLE authority for authorization (it rejects forged
 * `role` params and only grants debug/simulation to admin). These helpers are
 * used for fast initial render (default tab + which tabs to show) and are kept
 * in sync with the server mapping. Debug/diagnostics are never gated by a
 * localStorage flag here — only by the auth roles carried by the JWT.
 */

export const WORKBENCH_ROLES: RoleWorkbenchRole[] = [
  'operator',
  'team_lead',
  'quality',
  'equipment',
  'manager',
];

const AUTH_ROLE_TO_WORKBENCH: Record<string, readonly RoleWorkbenchRole[]> = {
  worker: ['operator'],
  workshop_lead: ['operator', 'team_lead', 'quality'],
  dispatcher: ['operator', 'team_lead', 'equipment', 'manager'],
  device_ops: ['operator', 'equipment'],
  safety_admin: ['operator', 'quality'],
  global_admin: ['operator', 'team_lead', 'quality', 'equipment', 'manager'],
};

const OWN_WORKBENCH_ROLE: ReadonlyArray<readonly [string, RoleWorkbenchRole]> = [
  ['global_admin', 'manager'],
  ['dispatcher', 'team_lead'],
  ['workshop_lead', 'team_lead'],
  ['device_ops', 'equipment'],
  ['safety_admin', 'quality'],
  ['worker', 'operator'],
];

export function resolveAuthorizedWorkbenchRoles(
  authRoles: readonly string[],
): RoleWorkbenchRole[] {
  const authorized = new Set<RoleWorkbenchRole>();
  for (const authRole of authRoles ?? []) {
    for (const workbenchRole of AUTH_ROLE_TO_WORKBENCH[authRole] ?? []) {
      authorized.add(workbenchRole);
    }
  }
  if (authorized.size === 0) {
    authorized.add('operator');
  }
  return WORKBENCH_ROLES.filter((role) => authorized.has(role));
}

/**
 * Default workbench role for the current authenticated user. Never `manager`
 * for an ordinary user — only a global_admin maps to manager by default.
 */
export function resolveDefaultWorkbenchRole(
  authRoles: readonly string[],
): RoleWorkbenchRole {
  for (const [authRole, ownRole] of OWN_WORKBENCH_ROLE) {
    if ((authRoles ?? []).includes(authRole)) {
      return ownRole;
    }
  }
  return 'operator';
}

export function canUseWorkbenchDebug(authRoles: readonly string[]): boolean {
  return (authRoles ?? []).includes('global_admin');
}