import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { StandaloneAppModule } from './standalone-app.module';

export function corsOrigins(value = process.env.CORS_ORIGINS): string[] | false {
  const origins = (value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.includes('*')) {
    throw new Error('CORS_ORIGINS must list explicit origins when credentials are enabled');
  }
  return origins.length > 0 ? origins : false;
}

export function applySecurityHeaders(res: {
  setHeader: (name: string, value: string) => void;
}): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // AUDIT-005 曾收紧为 style-src 'self'；可用性自测（UX 目标）实测其破坏运行时样式：
      // ① sonner Toaster（全局挂载，document.createElement('style') 注入动画样式表）与
      // ② ui/chart.tsx ChartStyle（按 light/dark 主题类注入 CSS 自定义变量）在所有页面
      // 每页各产生 2 条 CSP 控制台报错，图表主题变量与 toast 动画被浏览器阻断。
      // style-src 的 unsafe-inline 残余风险为低（不含脚本执行能力；真正的 XSS 防线是
      // 保持严格的 script-src 'self'），故恢复 unsafe-inline，仅限 style 维度。
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
  );
}

export function trustProxySetting(value = process.env.TRUST_PROXY): number | boolean | string[] {
  const raw = (value || '').trim();
  if (!raw) {
    return 1;
  }
  if (raw.toLowerCase() === 'true') {
    throw new Error('TRUST_PROXY=true is not allowed; use a hop count or explicit proxy CIDRs');
  }
  if (raw.toLowerCase() === 'false') {
    return false;
  }
  const numeric = Number(raw);
  if (raw === String(numeric) && Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** SPA 入口候选（两种构建产物互斥：主应用 index.html / standalone index.standalone.html）。 */
export const SPA_INDEX_CANDIDATES = ['index.html', 'index.standalone.html'] as const;

/**
 * 解析当前存在的 SPA 入口文件名（无则 null）。
 *
 * **每次请求调用**：构建产物可能在运行期被替换（两种构建互斥且 standalone 会清空
 * dist/client）。启动时冻结会让服务器一直 sendFile 已被删除的文件 → SPA 路由全 500。
 */
export function resolveSpaIndexFile(clientDir: string): string | null {
  for (const candidate of SPA_INDEX_CANDIDATES) {
    if (existsSync(join(clientDir, candidate))) return candidate;
  }
  return null;
}

export function isSpaFallbackPath(path: string): boolean {
  return (
    !path.startsWith('/api/') &&
    !path.startsWith('/health') &&
    path !== '/metrics' &&
    !path.endsWith('.map')
  );
}

export async function bootstrapStandalone(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(StandaloneAppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });

  app.disable('x-powered-by');

  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });

  app.use((_req, res, next) => {
    applySecurityHeaders(res);
    next();
  });

  app.set('trust proxy', trustProxySetting());

  // BUG-005：gzip 压缩需在 Docker 镜像中安装 compression 包后启用。
  // 当前容器无 compression 依赖，暂不启用。

  app.useBodyParser('json', { limit: process.env.BODY_LIMIT || '1mb' });

  // BUG-009 修复：body-parser 超限错误返回 413 而非 500。
  app.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `请求体过大，最大允许 ${process.env.BODY_LIMIT || '1mb'}`,
          details: err.message,
          timestamp: Date.now(),
        },
      });
      return;
    }
    next(err);
  });

  const clientDir = join(process.cwd(), 'dist/client');
  /**
   * 解析 SPA 入口文件名（每次请求都解析，**不在启动时冻结**）。
   *
   * 为什么：两种前端产物互斥——`build:client` 产出 `index.html`（主应用），
   * `build:client:standalone` 产出 `index.standalone.html` 且会清空 dist/client。
   * 启动时冻结文件名后，只要运行期做了一次另一种构建，服务器就会一直 sendFile
   * 那个已被删除的文件 → 所有 SPA 路由 500，直到重启（2026-09-11 实测：
   * 浏览器真实链路三例全挂，日志 ENOENT dist/client/index.html）。
   */
  const resolveIndexFile = (): string | null => resolveSpaIndexFile(clientDir);
  const indexFile = resolveIndexFile();
  if (!indexFile) {
    Logger.warn(
      `前端产物缺失：${clientDir} 下没有 index.html / index.standalone.html（SPA 路由将返回 503，请先构建客户端）`,
      'StandaloneBootstrap',
    );
  }
  if (indexFile) {
    // MIN-003 修复：带 content-hash 的静态资源设长缓存；HTML 设 no-cache。
    app.useStaticAssets(clientDir, {
      index: indexFile,
      maxAge: 0,
      setHeaders: (res, filePath) => {
        if (filePath.includes('/assets/') && filePath !== join(clientDir, indexFile)) {
          // hash 静态资源：长期缓存
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.html')) {
          // HTML：不缓存，确保每次获取最新版本
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    });
    // SPA fallback：合法前端路由返回 index.html + 200，由 React Router 接管。
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && isSpaFallbackPath(req.path)) {
        const current = resolveIndexFile();
        if (!current) {
          // 产物缺失必须显式（503 + 可读原因），不能让运维看到"服务器内部错误"
          res.status(503).json({
            error: {
              code: 'CLIENT_BUNDLE_MISSING',
              message: '前端产物缺失：请构建客户端（npm run build:client:standalone）后重试',
              retryable: false,
            },
          });
          return;
        }
        res.status(200);
        res.sendFile(join(clientDir, current));
        return;
      }
      next();
    });
  }

  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, host);
  Logger.log(`EWOH standalone API listening on http://${host}:${port}`, 'StandaloneBootstrap');
}
