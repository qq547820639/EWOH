/* Phase 4 收口：真实后端启动脚本（供 Playwright Browser E2E 使用）。
 *
 * 与 E2E helper（startE2EApp）同构，但监听固定端口并保持进程存活，
 * 使真实浏览器可以访问完整后端（真实 PostgreSQL）。
 *
 * 用法：
 *   EWOH_E2E_RUNTIME_DATABASE_URL=postgresql://... node -r ts-node/register \
 *     -r tsconfig-paths/register test/e2e/standalone-e2e-server.ts
 */
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { StandaloneAppModule } from '../../server/standalone-app.module';

const PORT = Number(process.env.EWOH_E2E_SERVER_PORT || '3100');

async function bootstrap(): Promise<void> {
  process.env.EWOH_DEPLOY_TARGET = 'standalone';
  process.env.DATABASE_URL =
    process.env.EWOH_E2E_RUNTIME_DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:15432/ewoh_e2e_runtime';
  process.env.JWT_SECRET = process.env.EWOH_E2E_JWT_SECRET ?? 'e2e-test-secret-key-please-change';
  process.env.REFRESH_TOKEN_EXPIRES_IN = '7d';
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.EWOH_SIMULATOR_ORG_ID = process.env.EWOH_E2E_SIM_ORG ?? 'org-sim-e2e';
  // E2E 确定性：关闭模拟器避免世界状态被持续改写导致 PLAN_STALE。
  if (process.env.EWOH_SIMULATOR_DISABLED == null) process.env.EWOH_SIMULATOR_DISABLED = '1';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(PORT);
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = '';
  process.env.EWOH_BOOTSTRAP_ADMIN_USERNAME = process.env.EWOH_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
  process.env.EWOH_BOOTSTRAP_ADMIN_PASSWORD = process.env.EWOH_BOOTSTRAP_ADMIN_PASSWORD ?? 'Admin@123456';

  const app = await NestFactory.create<NestExpressApplication>(StandaloneAppModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });
  app.enableCors({ origin: true, credentials: true });
  app.set('trust proxy', true);

  await app.listen(PORT, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  // eslint-disable-next-line no-console
  console.log(`[standalone-e2e-server] listening on http://127.0.0.1:${address.port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[standalone-e2e-server] boot failed:', err);
  process.exit(1);
});
