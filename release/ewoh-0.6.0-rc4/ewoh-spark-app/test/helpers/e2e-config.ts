import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface E2EConfig {
  ownerDatabaseUrl: string;
  runtimeDatabaseUrl: string;
  jwtSecret: string;
  refreshTokenExpiresIn: string;
  rateLimitMax: string;
}

const DEFAULT_OWNER_DATABASE_URL =
  process.env.EWOH_E2E_OWNER_DATABASE_URL ??
  'postgresql://postgres:ewoh-test-only@127.0.0.1:55432/postgres';

function readProcessEnvironment(pid: string): string | null {
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('ps', ['eww', '-p', pid], { encoding: 'utf8' });
      const match = output.match(/(?:^|\s)DATABASE_URL=(\S+)/);
      return match?.[1] ?? null;
    }
    if (process.platform !== 'win32') {
      const environment = readFileSync(`/proc/${pid}/environ`, 'utf8');
      for (const entry of environment.split('\0')) {
        if (entry.startsWith('DATABASE_URL=')) {
          return entry.slice('DATABASE_URL='.length);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readRuntimeDatabaseUrlFromPort3101(): string | null {
  try {
    const pid = execFileSync(
      'lsof',
      ['-nP', '-iTCP:3101', '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 5000 },
    )
      .trim()
      .split('\n')[0];
    if (!pid) {
      return null;
    }
    return readProcessEnvironment(pid);
  } catch {
    return null;
  }
}

export function resolveE2EConfig(): E2EConfig | null {
  const runtimeDatabaseUrl =
    process.env.EWOH_E2E_RUNTIME_DATABASE_URL?.trim() ??
    readRuntimeDatabaseUrlFromPort3101();

  if (!runtimeDatabaseUrl) {
    console.warn(
      '[EWOH E2E] Runtime DATABASE_URL is unavailable. Set EWOH_E2E_RUNTIME_DATABASE_URL ' +
        'or start the standalone API on 127.0.0.1:3101 with DATABASE_URL; the E2E suite will skip.',
    );
    return null;
  }

  return {
    ownerDatabaseUrl: DEFAULT_OWNER_DATABASE_URL,
    runtimeDatabaseUrl,
    jwtSecret:
      process.env.JWT_SECRET?.trim() ||
      'ewoh-e2e-http-acceptance-secret-2026-08-03',
    refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN?.trim() || '1h',
    rateLimitMax: process.env.RATE_LIMIT_MAX?.trim() || '10000',
  };
}
