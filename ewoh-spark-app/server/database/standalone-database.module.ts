import { Global, Module } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import {
  RequestDatabaseContext,
  STANDALONE_ROOT_DATABASE,
} from './request-database-context';
import {
  STANDALONE_DATABASE_PROVIDER,
  STANDALONE_ROOT_DATABASE_PROVIDER,
} from './standalone.provider';

@Global()
@Module({
  providers: [
    STANDALONE_ROOT_DATABASE_PROVIDER,
    RequestDatabaseContext,
    STANDALONE_DATABASE_PROVIDER,
  ],
  exports: [
    DRIZZLE_DATABASE,
    RequestDatabaseContext,
    // Root database handle (system-level, no RLS/GUC). Since 7.2, business code
    // must reach it ONLY via RequestDatabaseContext.systemTransaction; this token
    // is still exported for the database plumbing itself and test helpers
    // (e.g. test/helpers/e2e-app.ts closes the pool). A @Global module only makes
    // its *exported* providers resolvable app-wide, so this token must be listed
    // here or Nest fails to inject it into non-global modules.
    STANDALONE_ROOT_DATABASE,
  ],
})
export class StandaloneDatabaseModule {}
