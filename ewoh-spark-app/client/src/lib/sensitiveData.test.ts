import {
  expiresAt,
  isRecordExpired,
  isSensitiveKey,
  redactSensitiveFields,
  redactValue,
} from './sensitiveData';

describe('sensitiveData', () => {
  it('detects sensitive field names', () => {
    expect(isSensitiveKey('accessToken')).toBe(true);
    expect(isSensitiveKey('refresh_token')).toBe(true);
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('orderId')).toBe(false);
    expect(isSensitiveKey('stepId')).toBe(false);
  });

  it('redacts a single value to a mask', () => {
    expect(redactValue('secretstring')).toBe('***REDACTED***');
  });

  it('recursively redacts sensitive fields in a nested record', () => {
    const input = {
      orderId: 'WO-1',
      body: {
        note: 'hello',
        accessToken: 'abc',
      },
      nested: [{ password: 'pwd' }, { safe: 1 }],
    };
    const out = redactSensitiveFields(input) as typeof input;
    expect(out.orderId).toBe('WO-1');
    expect(out.body.note).toBe('hello');
    expect(out.body.accessToken).toBe('***REDACTED***');
    expect((out.nested[0] as { password: string }).password).toBe('***REDACTED***');
    expect(out.nested[1].safe).toBe(1);
    // 不原地修改原对象
    expect(input.body.accessToken).toBe('abc');
  });

  it('computes an absolute expiry timestamp', () => {
    expect(expiresAt(1000, 5000)).toBe(6000);
  });

  it('judges record expiry by updatedAt/createdAt', () => {
    const now = Date.now();
    const fresh = { createdAt: new Date(now).toISOString() };
    const stale = { createdAt: new Date(now - 10_000).toISOString() };
    expect(isRecordExpired(fresh, 5000, now)).toBe(false);
    expect(isRecordExpired(stale, 5000, now)).toBe(true);
    // 无时间戳不判定过期
    expect(isRecordExpired({}, 5000, now)).toBe(false);
  });
});