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
      "style-src 'self'",  // AUDIT-005 (P2)：移除 unsafe-inline，Tailwind 已迁移到 JIT 构建时生成
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
  const indexFile = existsSync(join(clientDir, 'index.html'))
    ? 'index.html'
    : 'index.standalone.html';
  if (existsSync(join(clientDir, indexFile))) {
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
        res.status(200);
        res.sendFile(join(clientDir, indexFile));
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
