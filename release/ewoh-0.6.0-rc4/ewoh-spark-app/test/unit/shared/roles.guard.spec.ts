import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../../server/modules/shared/roles.guard';
import { ROLES_KEY } from '../../../server/modules/shared/roles.decorator';
import { IS_PUBLIC_KEY } from '../../../server/modules/shared/public.decorator';

function makeContext(
  roles?: string[],
  options: { required?: string[]; isPublic?: boolean; controller?: unknown } = {},
) {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector as never);
  const handler = () => undefined;
  const controller = options.controller ?? class TestController {};
  if (options.required) {
    Reflect.defineMetadata(ROLES_KEY, options.required, handler);
  }
  if (options.isPublic) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ userContext: { roles } }),
    }),
  };
  return { guard, context: context as never };
}

describe('RolesGuard', () => {
  it('allows public routes without role metadata', () => {
    const { guard, context } = makeContext([], { isPublic: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies authenticated routes without role metadata by default', () => {
    const { guard, context } = makeContext(['viewer']);
    expect(guard.canActivate(context)).toBe(false);
  });

  it('allows matching roles and rejects mismatches', () => {
    const allowed = makeContext(['safety_admin'], {
      required: ['safety_admin', 'global_admin'],
    });
    expect(allowed.guard.canActivate(allowed.context)).toBe(true);

    const denied = makeContext(['dispatcher'], { required: ['safety_admin'] });
    expect(denied.guard.canActivate(denied.context)).toBe(false);
  });

  it('applies the conservative fallback for owner-locked controllers', () => {
    const controller = class SimulatorController {};
    const allowed = makeContext(['global_admin'], { controller });
    expect(allowed.guard.canActivate(allowed.context)).toBe(true);

    const denied = makeContext(['viewer'], { controller });
    expect(denied.guard.canActivate(denied.context)).toBe(false);
  });
});
