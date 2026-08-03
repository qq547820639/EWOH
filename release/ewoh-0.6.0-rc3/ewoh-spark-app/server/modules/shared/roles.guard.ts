import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { FALLBACK_CONTROLLER_ROLES } from './route-role.policy';

function rolesOf(userContext?: { roles?: string[] }): string[] {
  return userContext?.roles ?? [];
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const effectiveRoles =
      requiredRoles && requiredRoles.length > 0
        ? requiredRoles
        : FALLBACK_CONTROLLER_ROLES[context.getClass()?.name] ?? [];
    if (!effectiveRoles || effectiveRoles.length === 0) {
      // Default deny: authenticated business routes must declare @Roles or an
      // explicit public marker. This closes the previous allow-by-default hole.
      return false;
    }

    const request = context.switchToHttp().getRequest<{ userContext?: { roles?: string[] } }>();
    const roles = rolesOf(request.userContext);
    return effectiveRoles.some((role) => roles.includes(role));
  }
}
