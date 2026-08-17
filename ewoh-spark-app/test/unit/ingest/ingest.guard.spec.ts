import { ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { IngestGuard } from '../../../server/modules/ingest/ingest.guard';

function executionContext(ip: string, headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        ip,
        socket: { remoteAddress: ip },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('IngestGuard', () => {
  const originalKey = process.env.INGEST_API_KEY;
  const originalOrg = process.env.EWOH_INGEST_ORG_ID;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalInsecureDev = process.env.INGEST_INSECURE_DEV_MODE;
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    // 恢复所有受影响的环境变量
    const restore = (
      name: string,
      original: string | undefined,
    ): void => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    };
    restore('INGEST_API_KEY', originalKey);
    restore('EWOH_INGEST_ORG_ID', originalOrg);
    restore('NODE_ENV', originalNodeEnv);
    restore('INGEST_INSECURE_DEV_MODE', originalInsecureDev);
    restore('REDIS_URL', originalRedisUrl);
  });

  it('rejects missing or wrong keys when INGEST_API_KEY is configured', async () => {
    process.env.INGEST_API_KEY = 'secret-key';
    const guard = new IngestGuard();
    await expect(
      guard.canActivate(executionContext('127.0.0.1', {})),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        executionContext('127.0.0.1', { 'x-ingest-key': 'wrong' }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        executionContext('127.0.0.1', {
          'x-ingest-key': 'secret-key',
          'x-org-id': 'org-a',
        }),
      ),
    ).resolves.toBe(true);
  });

  it('FAIL-CLOSED: production + no INGEST_API_KEY rejects all ingest requests (503)', async () => {
    delete process.env.INGEST_API_KEY;
    process.env.NODE_ENV = 'production';
    const guard = new IngestGuard();
    await expect(
      guard.canActivate(
        executionContext('127.0.0.2', { 'x-org-id': 'org-a' }),
      ),
    ).rejects.toThrow(HttpException);
    // 即使带了任意 key 也拒绝（key 未配置时无有效凭据）
    await expect(
      guard.canActivate(
        executionContext('127.0.0.2', {
          'x-ingest-key': 'anything',
          'x-org-id': 'org-a',
        }),
      ),
    ).rejects.toThrow(HttpException);
  });

  it('FAIL-CLOSED: non-production + no INGEST_API_KEY + no explicit dev mode rejects', async () => {
    delete process.env.INGEST_API_KEY;
    delete process.env.NODE_ENV; // 非 production
    delete process.env.INGEST_INSECURE_DEV_MODE;
    const guard = new IngestGuard();
    await expect(
      guard.canActivate(
        executionContext('127.0.0.3', { 'x-org-id': 'org-a' }),
      ),
    ).rejects.toThrow(HttpException);
  });

  it('explicit INGEST_INSECURE_DEV_MODE=true allows keyless requests in non-production', async () => {
    delete process.env.INGEST_API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.REDIS_URL; // 内存回退限流（进程内单实例计数）
    process.env.INGEST_INSECURE_DEV_MODE = 'true';
    process.env.EWOH_INGEST_ORG_ID = 'org-dev';
    const guard = new IngestGuard();
    await expect(
      guard.canActivate(executionContext('192.0.2.10', {})),
    ).resolves.toBe(true);
  });

  it('rate limits one IP after 100 requests per minute', async () => {
    delete process.env.INGEST_API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.REDIS_URL; // 内存回退限流（进程内单实例计数）
    process.env.INGEST_INSECURE_DEV_MODE = 'true';
    process.env.EWOH_INGEST_ORG_ID = 'org-1';
    const guard = new IngestGuard();
    for (let index = 0; index < 100; index += 1) {
      await expect(
        guard.canActivate(
          executionContext('10.0.0.9', { 'x-org-id': 'org-1' }),
        ),
      ).resolves.toBe(true);
    }
    await expect(
      guard.canActivate(
        executionContext('10.0.0.9', { 'x-org-id': 'org-1' }),
      ),
    ).rejects.toThrow(HttpException);
  });

  it('requires an explicit org context for machine-to-machine ingestion', async () => {
    process.env.INGEST_API_KEY = 'secret-key';
    delete process.env.EWOH_INGEST_ORG_ID;
    const guard = new IngestGuard();
    await expect(
      guard.canActivate(
        executionContext('127.0.0.4', { 'x-ingest-key': 'secret-key' }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        executionContext('127.0.0.4', {
          'x-ingest-key': 'secret-key',
          'x-org-id': 'org-a',
        }),
      ),
    ).resolves.toBe(true);
  });
});
