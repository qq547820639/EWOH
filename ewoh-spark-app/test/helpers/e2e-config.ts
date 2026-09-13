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
  'postgresql://postgres:ewoh-local-audit-only@127.0.0.1:55432/ewoh';

function readProcessEnvironment(pid: string): string | null {
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('ps', ['eww', '-p', pid], {
        encoding: 'utf8',
      });
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

function buildConfig(runtimeDatabaseUrl: string): E2EConfig {
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

export function resolveE2EConfig(): E2EConfig | null {
  // CI-safe detection (Task 14.4): 一旦设置了 EWOH_E2E_RUNTIME_DATABASE_URL，
  // 即声明「真实-PG E2E 必须运行」。空/纯空白值属 CI 配置错误 —— 抛错响亮失败，
  // 绝不回退到 :3101 探测或整包静默 SKIP（防止 release gate 因误配置伪通过）。
  const envRuntimeUrl = process.env.EWOH_E2E_RUNTIME_DATABASE_URL;
  if (envRuntimeUrl !== undefined && envRuntimeUrl !== null) {
    const trimmed = envRuntimeUrl.trim();
    if (!trimmed) {
      throw new Error(
        '[EWOH E2E] EWOH_E2E_RUNTIME_DATABASE_URL is set but empty/whitespace: ' +
          'the real-PG E2E suite must not silently skip in CI. Set a real PostgreSQL URL ' +
          'or unset the variable (local desktop then falls back to the :3101 listener).',
      );
    }
    return buildConfig(trimmed);
  }

  // Local desktop: env var unset → 探测 127.0.0.1:3101 standalone API 的 DATABASE_URL。
  const runtimeDatabaseUrl = readRuntimeDatabaseUrlFromPort3101();
  if (!runtimeDatabaseUrl) {
    console.warn(
      '[EWOH E2E] Runtime DATABASE_URL is unavailable. Set EWOH_E2E_RUNTIME_DATABASE_URL ' +
        'or start the standalone API on 127.0.0.1:3101 with DATABASE_URL; the E2E suite will skip.',
    );
    return null;
  }

  return buildConfig(runtimeDatabaseUrl);
}
