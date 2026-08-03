export const EWOH_ROLES = [
  'global_admin',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
] as const;

export type EwohRole = (typeof EWOH_ROLES)[number];

export const EWOH_ROLE_LABELS: Record<EwohRole, string> = {
  global_admin: '全局管理员',
  dispatcher: '调度员',
  workshop_lead: '班组长',
  safety_admin: '安全管理员',
  device_ops: '设备运维',
};
