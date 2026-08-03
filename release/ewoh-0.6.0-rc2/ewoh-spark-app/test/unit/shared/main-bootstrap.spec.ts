import { resolveBootstrapMode } from '../../../server/main';

const ENV_KEYS = [
  'EWOH_DEPLOY_TARGET',
  'STANDALONE',
  'EWOH_LEGACY_ENABLED',
] as const;

describe('bootstrap mode security gate', () => {
  const original = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      original.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('throws by default instead of booting an unauthenticated legacy path', () => {
    delete process.env.EWOH_DEPLOY_TARGET;
    delete process.env.STANDALONE;
    delete process.env.EWOH_LEGACY_ENABLED;
    expect(() => resolveBootstrapMode()).toThrow(/EWOH_LEGACY_ENABLED/);
  });

  it('allows legacy mode only when EWOH_LEGACY_ENABLED=1 is explicit', () => {
    process.env.EWOH_LEGACY_ENABLED = '1';
    expect(resolveBootstrapMode()).toBe('legacy');
  });

  it('prefers standalone mode over legacy mode', () => {
    process.env.EWOH_LEGACY_ENABLED = '1';
    process.env.EWOH_DEPLOY_TARGET = 'standalone';
    expect(resolveBootstrapMode()).toBe('standalone');
  });

  it('honors STANDALONE=1 as standalone mode', () => {
    process.env.STANDALONE = '1';
    expect(resolveBootstrapMode()).toBe('standalone');
  });
});
