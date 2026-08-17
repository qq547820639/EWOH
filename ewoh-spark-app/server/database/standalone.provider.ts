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
    // NEST-524（2026-08-17）：SSL 显式化。连接串含 sslmode 参数时由 postgres
    // 按串处理；否则 DB_SSL=require 时启用 TLS（生产建议在入口对数据库强制
    // sslmode=require，避免明文链路）。DB_SSL=verify 时校验服务端证书。
    const sslMode = process.env.DB_SSL;
    const ssl =
      sslMode === 'require'
        ? { rejectUnauthorized: false }
        : sslMode === 'verify'
          ? { rejectUnauthorized: true }
          : undefined;
    const client = postgres(url, {
      max: poolMax,
      idle_timeout: Number(process.env.DB_POOL_IDLE_TIMEOUT || 30000),
      connect_timeout: 10,
      prepare: false,
      ...(ssl ? { ssl } : {}),
    });
    return drizzle(client);
  },
};

export const STANDALONE_DATABASE_PROVIDER = {
  provide: DRIZZLE_DATABASE,
  inject: [RequestDatabaseContext],
  useFactory: (context: RequestDatabaseContext) => context.database,
};
