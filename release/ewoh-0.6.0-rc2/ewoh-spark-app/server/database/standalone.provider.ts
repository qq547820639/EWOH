import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  RequestDatabaseContext,
  STANDALONE_ROOT_DATABASE,
} from './request-database-context';

export const STANDALONE_ROOT_DATABASE_PROVIDER = {
  provide: STANDALONE_ROOT_DATABASE,
  useFactory: () => {
    const url = process.env.DATABASE_URL || process.env.SUDA_DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required in standalone mode');
    }
    const poolMax = Number(process.env.DB_POOL_MAX || 20);
    const client = postgres(url, {
      max: poolMax,
      idle_timeout: Number(process.env.DB_POOL_IDLE_TIMEOUT || 30000),
      connect_timeout: 10,
      prepare: false,
    });
    return drizzle(client);
  },
};

export const STANDALONE_DATABASE_PROVIDER = {
  provide: DRIZZLE_DATABASE,
  inject: [RequestDatabaseContext],
  useFactory: (context: RequestDatabaseContext) => context.database,
};
