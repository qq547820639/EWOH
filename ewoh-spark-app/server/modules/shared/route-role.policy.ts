/**
 * Conservative RBAC fallback for controllers that cannot be edited in this
 * work item (owner modules under `server/modules/simulator`, `task`, `alert`,
 * `model`, `scheduler`, `control`, `approval`, `resource`, `world-cursor`).
 * Roles follow security/access-matrix.yaml centers; modules without a center
 * entry default to the most restrictive global_admin/safety_admin set.
 */
export const FALLBACK_CONTROLLER_ROLES: Record<string, string[]> = {
  SimulatorController: ['global_admin', 'safety_admin'],
  TaskController: ['global_admin', 'dispatcher', 'workshop_lead'],
  AlertController: ['global_admin', 'dispatcher', 'workshop_lead', 'safety_admin'],
  ModelController: ['global_admin', 'device_ops'],
  SchedulerController: ['global_admin', 'dispatcher', 'workshop_lead'],
  ControlController: ['global_admin', 'dispatcher'],
  ApprovalController: ['global_admin', 'workshop_lead', 'safety_admin'],
  ResourceController: ['global_admin', 'dispatcher'],
  WorldCursorController: ['global_admin', 'dispatcher', 'workshop_lead'],
};
