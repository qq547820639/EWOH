/**
 * resolveE2EConfig CI-safe detection 单测 (Task 14.4)。
 *
 * 保证：
 *   1. CI 路径：EWOH_E2E_RUNTIME_DATABASE_URL 设为真实 URL → 返回配置（套件真实运行）；
 *   2. CI 误配置：环境变量设置为空/纯空白 → 抛错（响亮失败），绝不回退 :3101 或静默整包 SKIP；
 *   3. 本地桌面路径不变：环境变量未设置且 :3101 无监听 → 返回 null（套件 SKIP，行为保持）。
 */
import { execFileSync } from 'node:child_process';
import { resolveE2EConfig } from './e2e-config';

jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: jest.fn(actual.execFileSync) };
});

const mockedExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

const ENV_KEYS = [
  'EWOH_E2E_RUNTIME_DATABASE_URL',
  'EWOH_E2E_OWNER_DATABASE_URL',
  'JWT_SECRET',
  'REFRESH_TOKEN_EXPIRES_IN',
  'RATE_LIMIT_MAX',
] as const;

const originalEnv = { ...process.env };

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('resolveE2EConfig CI-safe detection', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      setEnv(key, originalEnv[key]);
    }
    mockedExecFileSync.mockClear();
  });

  it('CI 路径：环境变量为真实 URL 时返回配置，且不触碰 :3101 探测', () => {
    setEnv('EWOH_E2E_RUNTIME_DATABASE_URL', 'postgresql://ewoh_api:pw@127.0.0.1:5432/ewoh');
    setEnv('EWOH_E2E_OWNER_DATABASE_URL', 'postgresql://owner:pw@127.0.0.1:5432/ewoh');

    const cfg = resolveE2EConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.runtimeDatabaseUrl).toBe('postgresql://ewoh_api:pw@127.0.0.1:5432/ewoh');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('CI 误配置：环境变量为空/纯空白时抛错（绝不允许整包静默 SKIP）', () => {
    setEnv('EWOH_E2E_RUNTIME_DATABASE_URL', '   ');
    setEnv('EWOH_E2E_OWNER_DATABASE_URL', 'postgresql://owner:pw@127.0.0.1:5432/ewoh');

    expect(() => resolveE2EConfig()).toThrow(/empty|whitespace/);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('本地桌面路径不变：环境变量未设置且 :3101 无监听时返回 null（SKIP 语义保留）', () => {
    setEnv('EWOH_E2E_RUNTIME_DATABASE_URL', undefined);
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('no listener on :3101');
    });

    const cfg = resolveE2EConfig();
    expect(cfg).toBeNull();
  });
});
