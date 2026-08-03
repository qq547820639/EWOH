import { Global, Module } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { RequestDatabaseContext } from './request-database-context';
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
  exports: [DRIZZLE_DATABASE, RequestDatabaseContext],
})
export class StandaloneDatabaseModule {}
