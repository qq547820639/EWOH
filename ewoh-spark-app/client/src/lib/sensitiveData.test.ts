import {
  expiresAt,
  isRecordExpired,
  isSensitiveKey,
  redactSensitiveFields,
  redactSensitiveQueryString,
  redactUrl,
  redactValue,
} from './sensitiveData';

describe('sensitiveData', () => {
  it('detects sensitive field names', () => {
    expect(isSensitiveKey('accessToken')).toBe(true);
    expect(isSensitiveKey('refresh_token')).toBe(true);
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('passphrase')).toBe(true);
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

  it('redacts sensitive query params in an absolute URL', () => {
    const out = redactUrl('https://ewoh.example/api?token=abc123&id=42&passphrase=hunter2&order=1');
    expect(out).toContain('token=***REDACTED***');
    expect(out).toContain('passphrase=***REDACTED***');
    expect(out).toContain('id=42');
    expect(out).toContain('order=1');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('hunter2');
  });

  it('redacts sensitive query params in a relative URL', () => {
    const out = redactUrl('/api/files?access_token=xyz&page=2');
    expect(out).toContain('access_token=***REDACTED***');
    expect(out).toContain('page=2');
    expect(out).not.toContain('xyz');
  });

  it('redacts a bare query string discarding sensitive values', () => {
    expect(redactSensitiveQueryString('?token=abc')).toBe('?token=***REDACTED***');
    expect(redactSensitiveQueryString('refreshToken=s&n=safe')).toContain('refreshToken=***REDACTED***');
    expect(redactSensitiveQueryString('n=safe')).toBe('n=safe');
  });

  it('leaves URLs without query params untouched', () => {
    expect(redactUrl('https://ewoh.example/health')).toBe('https://ewoh.example/health');
    expect(redactUrl('')).toBe('');
  });

  it('redacts PII and business secrets under sensitive keys (idCard/phone/token)', () => {
    const input = {
      orderId: 'WO-1',
      user: { name: '张三', idCard: '110101199001011234', phone: '13800000000' },
      device: { accessToken: 'Bearer xyz', serial: 'SN-9' },
      fileName: 'secret-api-keys.xlsx',
    };
    const out = redactSensitiveFields(input) as typeof input;
    expect(out.orderId).toBe('WO-1');
    expect(out.user.name).toBe('张三');
    expect(out.user.idCard).toBe('***REDACTED***');
    expect(out.user.phone).toBe('***REDACTED***');
    expect(out.device.accessToken).toBe('***REDACTED***');
    expect(out.device.serial).toBe('SN-9');
    // 文件名本身不敏感，但若其键名敏感（如承载密钥类文档元数据）则子层脱敏。
    expect(out.fileName).toBe('secret-api-keys.xlsx');
  });

  it('redacts a whole sensitive-named container and leaves safe siblings intact', () => {
    const input = {
      credentials: { password: 'p', refreshToken: 't' },
      safe: { fileName: 'report.pdf' },
    };
    const out = redactSensitiveFields(input) as typeof input;
    // 敏感键名（credentials）的整个取值被掩码覆盖，不递归泄漏其内部。
    expect(out.credentials).toBe('***REDACTED***');
    expect(out.safe.fileName).toBe('report.pdf');
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