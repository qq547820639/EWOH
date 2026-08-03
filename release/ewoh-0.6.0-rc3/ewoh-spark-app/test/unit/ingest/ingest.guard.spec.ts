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

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.INGEST_API_KEY;
    } else {
      process.env.INGEST_API_KEY = originalKey;
    }
    if (originalOrg === undefined) {
      delete process.env.EWOH_INGEST_ORG_ID;
    } else {
      process.env.EWOH_INGEST_ORG_ID = originalOrg;
    }
  });

  it('rejects missing or wrong keys when INGEST_API_KEY is configured', () => {
    process.env.INGEST_API_KEY = 'secret-key';
    const guard = new IngestGuard();
    expect(() =>
      guard.canActivate(executionContext('127.0.0.1', {})),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(
        executionContext('127.0.0.1', { 'x-ingest-key': 'wrong' }),
      ),
    ).toThrow(UnauthorizedException);
    expect(
      guard.canActivate(
        executionContext('127.0.0.1', {
          'x-ingest-key': 'secret-key',
          'x-org-id': 'org-a',
        }),
      ),
    ).toBe(true);
  });

  it('rate limits one IP after 100 requests per minute', () => {
    delete process.env.INGEST_API_KEY;
    process.env.EWOH_INGEST_ORG_ID = 'org-1';
    const guard = new IngestGuard();
    for (let index = 0; index < 100; index += 1) {
      expect(
        guard.canActivate(
          executionContext('10.0.0.9', { 'x-org-id': 'org-1' }),
        ),
      ).toBe(true);
    }
    expect(() =>
      guard.canActivate(
        executionContext('10.0.0.9', { 'x-org-id': 'org-1' }),
      ),
    ).toThrow(HttpException);
  });

  it('requires an explicit org context for machine-to-machine ingestion', () => {
    process.env.INGEST_API_KEY = 'secret-key';
    delete process.env.EWOH_INGEST_ORG_ID;
    const guard = new IngestGuard();
    expect(() =>
      guard.canActivate(
        executionContext('127.0.0.1', { 'x-ingest-key': 'secret-key' }),
      ),
    ).toThrow(UnauthorizedException);
    expect(
      guard.canActivate(
        executionContext('127.0.0.1', {
          'x-ingest-key': 'secret-key',
          'x-org-id': 'org-a',
        }),
      ),
    ).toBe(true);
  });
});
