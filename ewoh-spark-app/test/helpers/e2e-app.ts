import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { STANDALONE_ROOT_DATABASE } from '../../server/database/request-database-context';
import { installPgConnectionFaultGuard } from '../../server/database/standalone.provider';
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
  // R-4（2026-09-13）生产入口（server/main.ts bootstrap）在 Nest 建连前安装
  // 进程级 PgFaultGuard；进程内 E2E 启动必须同样装配，否则故障注入类用例
  // （pg-temporary-failure）终止在飞事务的连接时会命中 postgres@3.4.9
  // write/close 竞态，TypeError 脱离 Promise 链直接打断测试——产品形态下
  // 该故障被守卫接管、请求以结构化 5xx 暴露。仅连接类故障被接管，其余
  // 异常仍保持 Node 默认语义（重复安装自动替换上一次）。
  installPgConnectionFaultGuard();
  process.env.EWOH_DEPLOY_TARGET = 'standalone';
  process.env.DATABASE_URL = config.runtimeDatabaseUrl;
  process.env.JWT_SECRET = config.jwtSecret;
  process.env.REFRESH_TOKEN_EXPIRES_IN = config.refreshTokenExpiresIn;
  process.env.RATE_LIMIT_MAX = config.rateLimitMax;
  // E2E suites intentionally authenticate many scoped fixture users in one
  // process. Keep production defaults untouched; this is test-app wiring.
  process.env.LOGIN_RATE_LIMIT_MAX =
    process.env.LOGIN_RATE_LIMIT_MAX || '10000';
  // 摄入网关 fail-closed（P1-INGEST-002）：测试应用同样必须显式配置，否则所有
  // /api/ingest/* 返回 503 INGEST_API_KEY_NOT_CONFIGURED（2026-09-15 fresh-runtime
  // 库实测：ewoh-http e2e 的 UnifiedExoFrame 摄入腿因此 503）。用 legacy 无绑定
  // 模式（org 取客户端 X-Org-Id 头）——与各 spec 的请求写法一致；限流放宽到
  // 机群级（spec 单进程内高频摄入）。
  process.env.INGEST_API_KEY = process.env.INGEST_API_KEY || 'e2e-ingest-key';
  process.env.INGEST_RATE_LIMIT = process.env.INGEST_RATE_LIMIT || '100000';
  // 各 spec 的摄入调用不带 x-ingest-key（只发 x-org-id）→ 非 production 需要
  // 显式 insecure dev 模式才允许无 key 请求（守卫 fail-closed 的测试侧开关）。
  process.env.INGEST_INSECURE_DEV_MODE =
    process.env.INGEST_INSECURE_DEV_MODE || 'true';
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
