import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { STANDALONE_ROOT_DATABASE } from '../../server/database/request-database-context';
import { StandaloneAppModule } from '../../server/standalone-app.module';
import {
  corsOrigins,
  trustProxySetting,
} from '../../server/standalone-main';
import type { E2EConfig } from './e2e-config';

export interface E2EAppHandle {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

interface RootDatabaseHandle {
  $client?: {
    end(): Promise<void>;
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
  process.env.EWOH_SIMULATOR_ORG_ID = simulatorOrgId;
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = '';

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
    async close() {
      await app.close();
      await rootDatabase.$client?.end();
    },
  };
}
