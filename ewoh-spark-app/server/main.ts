import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { configureApp } from '@lark-apaas/fullstack-nestjs-core';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { installPgConnectionFaultGuard } from './database/standalone.provider';
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
  // M4 提示：legacy 装配是兼容入口（缺 RateLimitGuard/Tracing 级联 12 个模块），
  // 新功能与治理只进 standalone。生产建议 EWOH_DEPLOY_TARGET=standalone。
  logger.warn(
    'Legacy mode: assembly differs from standalone (missing 12 modules + metrics/ratelimit guarantees). Use EWOH_DEPLOY_TARGET=standalone for full feature set.',
  );
}

export type BootstrapMode = 'standalone' | 'legacy';

/**
 * R-4 边界自查（2026-09-13）：兜底只保护"已开始服务"的进程，**不**保护启动期。
 *
 * 为什么 bootstrap 的失败必须显式 exit：R-4 守卫会把携带连接错误码的
 * unhandledRejection 接管成"进程继续运行"（实测复现：对守卫进程
 * `Promise.reject({code:'CONNECTION_CLOSED'})`，300ms 后进程仍存活）。
 * 而 bootstrap() 被调用处若不挂 catch，Nest 工厂/init 期间的数据库抖动
 * （连接失败、init 查询被打断 → abortOnError 拒绝）恰好就以这种
 * unhandledRejection 的形态到达顶层——结果是一个**端口从未监听、也不退出**
 * 的僵尸进程：健康检查永远起不来，编排层等不到退出码，重启循环被吞掉。
 * 启动期失败唯一正确的语义是退出码 1 交给编排层重试；服务期的连接抖动
 * 才归 installPgConnectionFaultGuard 管。
 */
export function exitOnBootstrapFailure(boot: Promise<void>): void {
  void boot.catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      '[Bootstrap] 启动失败，进程退出（exit 1；服务期连接抖动由 PgFaultGuard 兜底，启动期失败必须交给编排层重启）',
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
}

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
  // R-4（2026-09-13）：进程级连接故障兜底必须先于任何数据库连接建立——
  // Nest 工厂在 listen 之前就会建连，首批请求期间撞上 postgres 驱动的
  // write/close 竞态（事务回滚打在已置空的 socket 上）时，没有这层兜底
  // 进程会直接退出（单条坏连接带走整个 API）。仅连接类故障被接管，其余
  // 异常仍按 Node 默认语义退出。
  installPgConnectionFaultGuard();
  const mode = resolveBootstrapMode();
  if (mode === 'standalone') {
    await bootstrapStandalone();
    return;
  }
  await bootstrapLegacy();
}

if (require.main === module) {
  exitOnBootstrapFailure(bootstrap());
}
