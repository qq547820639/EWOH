/**
 * Role Workbench access control.
 *
 * Pure authorization helpers (no DB / I/O) so the server can be the sole
 * authority for:
 *   - which workbench roles (operator / team_lead / quality / equipment /
 *     manager) an authenticated user may view (TR-9.1: a forged `role` query
 *     param must be rejected server-side);
 *   - the default workbench role for a user (TR-9.2: never `manager` for an
 *     ordinary user);
 *   - debug / diagnostics and "simulate as another role" privileges, which
 *     MUST come from the server permission mapping — never from a client
 *     localStorage flag.
 *
 * The auth taxonomy lives in security/access-matrix.yaml (global_admin,
 * dispatcher, workshop_lead, safety_admin, device_ops, worker, viewer). The
 * workbench roles are a separate product taxonomy and the mapping below is the
 * single source of truth shared by the controller and the service.
 */

export const WORKBENCH_ROLES = [
  'operator',
  'team_lead',
  'quality',
  'equipment',
  'manager',
] as const;

export type WorkbenchRole = (typeof WORKBENCH_ROLES)[number];

/** Auth role → set of workbench roles the user is allowed to view. */
const AUTH_ROLE_TO_WORKBENCH: Record<string, readonly WorkbenchRole[]> = {
  worker: ['operator'],
  workshop_lead: ['operator', 'team_lead', 'quality'],
  dispatcher: ['operator', 'team_lead', 'quality', 'equipment', 'manager'],
  device_ops: ['operator', 'equipment'],
  safety_admin: ['operator', 'quality'],
  global_admin: ['operator', 'team_lead', 'quality', 'equipment', 'manager'],
};

/**
 * The workbench role that most directly reflects a user's own business
 * function. Priority order matters for users holding multiple auth roles.
 * Ordinary users map to a non-manager role; only global_admin maps to manager.
 */
const OWN_WORKBENCH_ROLE: ReadonlyArray<readonly [string, WorkbenchRole]> = [
  ['global_admin', 'manager'],
  ['dispatcher', 'team_lead'],
  ['workshop_lead', 'team_lead'],
  ['device_ops', 'equipment'],
  ['safety_admin', 'quality'],
  ['worker', 'operator'],
];

export function resolveAuthorizedWorkbenchRoles(
  authRoles: readonly string[],
): WorkbenchRole[] {
  const authorized = new Set<WorkbenchRole>();
  for (const authRole of authRoles ?? []) {
    for (const workbenchRole of AUTH_ROLE_TO_WORKBENCH[authRole] ?? []) {
      authorized.add(workbenchRole);
    }
  }
  // Every authenticated user can at least reach the operator view.
  if (authorized.size === 0) {
    authorized.add('operator');
  }
  return WORKBENCH_ROLES.filter((role) => authorized.has(role));
}

/** Whether the user may view the given workbench role (server-side check). */
export function canAccessWorkbenchRole(
  authRoles: readonly string[],
  role: WorkbenchRole,
): boolean {
  return resolveAuthorizedWorkbenchRoles(authRoles).includes(role);
}

/**
 * Default workbench role for a user. Never `manager` for ordinary users —
 * only a global_admin maps to manager by default.
 */
export function resolveDefaultWorkbenchRole(
  authRoles: readonly string[],
): WorkbenchRole {
  for (const [authRole, ownRole] of OWN_WORKBENCH_ROLE) {
    if ((authRoles ?? []).includes(authRole)) {
      return ownRole;
    }
  }
  return 'operator';
}

/** Debug / diagnostics require a server-granted permission (admin only). */
export function canUseWorkbenchDebug(authRoles: readonly string[]): boolean {
  return (authRoles ?? []).includes('global_admin');
}

/** "Simulate as another role" is an admin-only privilege. */
export function canUseWorkbenchSimulation(
  authRoles: readonly string[],
): boolean {
  return (authRoles ?? []).includes('global_admin');
}