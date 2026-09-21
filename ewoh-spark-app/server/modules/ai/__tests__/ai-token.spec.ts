/** AI → edge service-account token hardening regression tests. */
import { getEdgePlatformToken, resetEdgePlatformTokenCacheForTests } from '../ai.controller';

describe('edge platform service token', () => {
  const originalPassword = process.env.EDGE_PLATFORM_PASSWORD;

  afterEach(() => {
    if (originalPassword === undefined) {
      delete process.env.EDGE_PLATFORM_PASSWORD;
    } else {
      process.env.EDGE_PLATFORM_PASSWORD = originalPassword;
    }
    resetEdgePlatformTokenCacheForTests();
    jest.restoreAllMocks();
  });

  it('does not use a built-in password and fails explicitly when unconfigured', async () => {
    delete process.env.EDGE_PLATFORM_PASSWORD;
    const login = jest.fn();
    global.fetch = login as unknown as typeof fetch;

    await expect(getEdgePlatformToken()).rejects.toThrow(/EDGE_PLATFORM_PASSWORD/);
    expect(login).not.toHaveBeenCalled();
  });

  it('shares one concurrent refresh and does not login again', async () => {
    process.env.EDGE_PLATFORM_PASSWORD = 'test-secret';
    let logins = 0;
    global.fetch = jest.fn(async () => {
      logins += 1;
      return new Response(JSON.stringify({ token: `token-${logins}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const [first, second, third] = await Promise.all([
      getEdgePlatformToken(),
      getEdgePlatformToken(),
      getEdgePlatformToken(),
    ]);

    expect(logins).toBe(1);
    expect(first).toBe('token-1');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await getEdgePlatformToken()).toBe(first);
    expect(logins).toBe(1);
  });

  it('clears a failed refresh so the next caller can retry', async () => {
    process.env.EDGE_PLATFORM_PASSWORD = 'test-secret';
    let fail = true;
    global.fetch = jest.fn(async () => {
      if (fail) {
        return new Response('', { status: 503 });
      }
      return new Response(JSON.stringify({ token: 'retry-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(getEdgePlatformToken()).rejects.toThrow(/HTTP 503/);
    fail = false;
    await expect(getEdgePlatformToken()).resolves.toBe('retry-token');
  });
});
