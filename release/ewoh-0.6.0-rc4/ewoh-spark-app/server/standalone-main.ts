import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
    !path.startsWith('/health/') &&
    path !== '/metrics'
  );
}

export async function bootstrapStandalone(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(StandaloneAppModule, {
    abortOnError: false,
  });

  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });

  app.use((_req, res, next) => {
    applySecurityHeaders(res);
    next();
  });

  app.set('trust proxy', trustProxySetting());

  app.useBodyParser('json', { limit: process.env.BODY_LIMIT || '1mb' });

  const clientDir = join(process.cwd(), 'dist/client');
  const indexFile = existsSync(join(clientDir, 'index.html'))
    ? 'index.html'
    : 'index.standalone.html';
  if (existsSync(join(clientDir, indexFile))) {
    app.useStaticAssets(clientDir, { index: indexFile });
    app.use((req, res, next) => {
      if (
        req.method === 'GET' &&
        isSpaFallbackPath(req.path)
      ) {
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
