import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { configureApp } from '@lark-apaas/fullstack-nestjs-core';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { bootstrapStandalone } from './standalone-main';

async function bootstrapLegacy() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });
  await configureApp(app, {
    disableSwagger: true,
  });
  // Ingestion 请求体大小限制 1MB（防止超大 payload）
  app.useBodyParser('json', { limit: '1mb' });
  const logger = new Logger('Bootstrap');
  const host = process.env.SERVER_HOST || 'localhost';
  const port = Number(process.env.SERVER_PORT || '3000');

  // 注册视图引擎, 渲染 client 目录下的 html 文件
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  await app.listen(port, host);
  logger.log(`Server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
}

export type BootstrapMode = 'standalone' | 'legacy';

export function resolveBootstrapMode(): BootstrapMode {
  if (
    process.env.EWOH_DEPLOY_TARGET === 'standalone' ||
    process.env.STANDALONE === '1'
  ) {
    return 'standalone';
  }
  if (process.env.EWOH_LEGACY_ENABLED === '1') {
    return 'legacy';
  }
  throw new Error(
    'Legacy bootstrap is disabled by default. Set EWOH_LEGACY_ENABLED=1 to opt in, or use EWOH_DEPLOY_TARGET=standalone / STANDALONE=1.',
  );
}

async function bootstrap() {
  const mode = resolveBootstrapMode();
  if (mode === 'standalone') {
    await bootstrapStandalone();
    return;
  }
  await bootstrapLegacy();
}

if (require.main === module) {
  bootstrap();
}
