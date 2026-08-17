/* 前端角色注册表（单一权威源投影）。
 *
 * CLI-601/602（2026-08-17 审计）：与服务端
 * server/modules/shared/roles.decorator.ts 的 ANY_AUTHENTICATED_ROLES
 * 逐项对齐（7 角色，含 viewer——e2e /api/me 已返回 viewer，此前缺注册
 * 导致 EWOH_ROLE_LABELS 索引得 undefined）。角色语义变更须先改服务端
 * roles.decorator.ts 再同步本表。
 */
export const EWOH_ROLES = [
  'viewer',
  'worker',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
  'global_admin',
] as const;

export type EwohRole = (typeof EWOH_ROLES)[number];

export const EWOH_ROLE_LABELS: Record<EwohRole, string> = {
  viewer: '只读访客',
  worker: '一线作业员',
  dispatcher: '调度员',
  workshop_lead: '班组长',
  safety_admin: '安全管理员',
  device_ops: '设备运维',
  global_admin: '全局管理员',
};
