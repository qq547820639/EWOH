import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'ewoh_roles';

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const ANY_AUTHENTICATED_ROLES = [
  'viewer',
  'worker',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
  'global_admin',
] as const;
