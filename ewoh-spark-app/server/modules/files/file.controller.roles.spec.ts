import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../shared/roles.guard';
import { FileController } from './file.controller';

describe('FileController field evidence role boundary', () => {
  function context(method: keyof FileController, userRoles: string[]) {
    const handler = FileController.prototype[method] as unknown as object;
    return {
      getHandler: () => handler,
      getClass: () => FileController,
      switchToHttp: () => ({
        getRequest: () => ({ userContext: { roles: userRoles } }),
      }),
    } as never;
  }

  function guard() {
    return new RolesGuard(new Reflector());
  }

  it('allows a field worker to upload exception evidence', () => {
    expect(guard().canActivate(context('upload', ['worker']))).toBe(true);
    expect(guard().canActivate(context('upload', ['workshop_lead']))).toBe(true);
    expect(guard().canActivate(context('upload', ['device_ops']))).toBe(true);
  });

  it('keeps viewer accounts out of file uploads', () => {
    expect(guard().canActivate(context('upload', ['viewer']))).toBe(false);
  });

  it('keeps the controller default for deletion without broadening to workers', () => {
    expect(guard().canActivate(context('remove', ['global_admin']))).toBe(true);
    expect(guard().canActivate(context('remove', ['worker']))).toBe(false);
  });
});
