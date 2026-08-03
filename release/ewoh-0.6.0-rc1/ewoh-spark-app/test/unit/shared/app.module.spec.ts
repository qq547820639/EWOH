import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../../../server/app.module';
import { AccessTokenGuard } from '../../../server/modules/shared/access-token.guard';
import { AuthModule } from '../../../server/modules/auth/auth.module';
import { StandaloneDatabaseModule } from '../../../server/database/standalone-database.module';

describe('AppModule legacy security wiring', () => {
  it('registers AccessTokenGuard as a global guard', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    const guards = providers.filter(
      (provider) => (provider as { provide?: unknown }).provide === APP_GUARD,
    );
    expect(
      guards.some(
        (guard) =>
          (guard as { useExisting?: unknown }).useExisting === AccessTokenGuard,
      ),
    ).toBe(true);
  });

  it('provides the request database context and auth module in legacy mode', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(StandaloneDatabaseModule);
    expect(imports).toContain(AuthModule);
  });
});
