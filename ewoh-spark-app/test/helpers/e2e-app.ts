import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { STANDALONE_ROOT_DATABASE } from '../../server/database/request-database-context';
import { StandaloneAppModule } from '../../server/standalone-app.module';
import { corsOrigins, trustProxySetting } from '../../server/standalone-main';
import type { E2EConfig } from './e2e-config';
import { randomUUID } from 'node:crypto';

export interface E2EAppHandle {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
  databaseApplicationName: string;
}

interface RootDatabaseHandle {
  $client?: {
    end(options?: { timeout: number }): Promise<void>;
  };
}

export async function startE2EApp(
  config: E2EConfig,
  simulatorOrgId: string,
): Promise<E2EAppHandle> {
  process.env.EWOH_DEPLOY_TARGET = 'standalone';
  process.env.DATABASE_URL = config.runtimeDatabaseUrl;
  process.env.JWT_SECRET = config.jwtSecret;
  process.env.REFRESH_TOKEN_EXPIRES_IN = config.refreshTokenExpiresIn;
  process.env.RATE_LIMIT_MAX = config.rateLimitMax;
  // E2E suites intentionally authenticate many scoped fixture users in one
  // process. Keep production defaults untouched; this is test-app wiring.
  process.env.LOGIN_RATE_LIMIT_MAX =
    process.env.LOGIN_RATE_LIMIT_MAX || '10000';
  process.env.EWOH_SIMULATOR_ORG_ID = simulatorOrgId;
  // E2E 确定性：模拟器持续改写世界状态会使快照新鲜度校验（entityVersions 严格
  // 一致）必然失败（PLAN_STALE）。E2E 关闭模拟器，用 fixture 数据保证可复现。
  if (process.env.EWOH_SIMULATOR_DISABLED == null) {
    process.env.EWOH_SIMULATOR_DISABLED = '1';
  }
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = '';
  const databaseApplicationName = `ewoh-e2e-${randomUUID().slice(0, 12)}`;
  const databaseUrl = new URL(config.runtimeDatabaseUrl);
  databaseUrl.searchParams.set('application_name', databaseApplicationName);
  process.env.DATABASE_URL = databaseUrl.toString();

  const app = await NestFactory.create<NestExpressApplication>(
    StandaloneAppModule,
    {
      abortOnError: false,
      logger: false,
    },
  );
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });
  app.set('trust proxy', trustProxySetting());
  app.useBodyParser('json', { limit: process.env.BODY_LIMIT || '1mb' });

  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    await app.close();
    throw new Error('Could not determine E2E app port');
  }

  const rootDatabase = app.get(STANDALONE_ROOT_DATABASE) as RootDatabaseHandle;
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  return {
    app,
    baseUrl,
    databaseApplicationName,
    async close() {
      try {
        await app.close();
      } finally {
        await rootDatabase.$client?.end({ timeout: 5 });
      }
    },
  };
}
