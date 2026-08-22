import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'ewoh_roles';
export const FALLBACK_ROLES_KEY = 'ewoh_fallback_roles';

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** AUDIT-002：为控制器声明保守 fallback 角色（替代类名字符串匹配）。 */
export const FallbackRoles = (...roles: string[]) => SetMetadata(FALLBACK_ROLES_KEY, roles);

export const ANY_AUTHENTICATED_ROLES = [
  'viewer',
  'worker',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
  'global_admin',
] as const;
