/**
 * systemLogic.test.ts — System 数据页纯逻辑测试（ADR-089，§17/§33）。
 */
import {
  SENSITIVE_CONFIG_KEY_RE,
  PARAMETER_TYPES,
  formatSystemTime,
  parseParameterValue,
  redactConfigValue,
  PARAMETER_STATUS_LABEL,
  parameterStatusLabel,
} from './systemLogic';

describe('systemLogic', () => {
  describe('SENSITIVE_CONFIG_KEY_RE', () => {
    it('matches common sensitive key patterns', () => {
      expect(SENSITIVE_CONFIG_KEY_RE.test('api_secret')).toBe(true);
      expect(SENSITIVE_CONFIG_KEY_RE.test('AUTH_TOKEN')).toBe(true);
      expect(SENSITIVE_CONFIG_KEY_RE.test('db_password')).toBe(true);
      expect(SENSITIVE_CONFIG_KEY_RE.test('apiKey')).toBe(true);
      expect(SENSITIVE_CONFIG_KEY_RE.test('api-key')).toBe(true);
      expect(SENSITIVE_CONFIG_KEY_RE.test('credential')).toBe(true);
    });

    it('does not match non-sensitive keys', () => {
      expect(SENSITIVE_CONFIG_KEY_RE.test('hostname')).toBe(false);
      expect(SENSITIVE_CONFIG_KEY_RE.test('port')).toBe(false);
      expect(SENSITIVE_CONFIG_KEY_RE.test('database_name')).toBe(false);
    });
  });

  describe('PARAMETER_TYPES', () => {
    it('has five entries', () => {
      expect(PARAMETER_TYPES).toHaveLength(5);
      expect(PARAMETER_TYPES).toContain('string');
      expect(PARAMETER_TYPES).toContain('number');
      expect(PARAMETER_TYPES).toContain('json');
    });
  });

  describe('formatSystemTime', () => {
    it('formats ISO timestamp', () => {
      const result = formatSystemTime('2026-08-16T08:00:00.000Z');
      expect(result).toContain('16');
      expect(result).toContain(':');
    });

    it('returns dash for null/undefined/empty', () => {
      expect(formatSystemTime(null)).toBe('—');
      expect(formatSystemTime(undefined)).toBe('—');
      expect(formatSystemTime('')).toBe('—');
    });
  });

  describe('parseParameterValue', () => {
    it('parses number type', () => {
      expect(parseParameterValue('number', '42')).toBe(42);
      expect(parseParameterValue('number', '3.14')).toBe(3.14);
      expect(parseParameterValue('number', 'NaN')).toBe('NaN'); // falls back
      expect(parseParameterValue('number', 'abc')).toBe('abc');
    });

    it('parses integer type', () => {
      expect(parseParameterValue('integer', '42')).toBe(42);
      expect(parseParameterValue('integer', '3.14')).toBe('3.14'); // not integer → falls back
      expect(parseParameterValue('integer', 'abc')).toBe('abc');
    });

    it('parses boolean type', () => {
      expect(parseParameterValue('boolean', 'true')).toBe(true);
      expect(parseParameterValue('boolean', 'false')).toBe(false);
      expect(parseParameterValue('boolean', 'yes')).toBe(false);
    });

    it('parses json type', () => {
      expect(parseParameterValue('json', '{"a":1}')).toEqual({ a: 1 });
      expect(parseParameterValue('json', '[1,2]')).toEqual([1, 2]);
      expect(parseParameterValue('json', 'invalid')).toBe('invalid');
    });

    it('returns raw string for unknown/empty type', () => {
      expect(parseParameterValue('string', 'hello')).toBe('hello');
      expect(parseParameterValue('', 'hello')).toBe('hello');
    });
  });

  describe('redactConfigValue', () => {
    it('redacts sensitive keys in flat objects', () => {
      const input = { hostname: 'prod', apiKey: 'sk-123', port: 8080 };
      const result = redactConfigValue(input) as Record<string, unknown>;
      expect(result.hostname).toBe('prod');
      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.port).toBe(8080);
    });

    it('recursively redacts nested objects', () => {
      const input = { db: { host: 'localhost', password: 'secret123' } };
      const result = redactConfigValue(input) as Record<string, unknown>;
      expect((result.db as Record<string, unknown>).host).toBe('localhost');
      expect((result.db as Record<string, unknown>).password).toBe('[REDACTED]');
    });

    it('redacts within arrays', () => {
      const input = [{ token: 'abc' }, { name: 'safe' }];
      const result = redactConfigValue(input) as Array<Record<string, unknown>>;
      expect(result[0].token).toBe('[REDACTED]');
      expect(result[1].name).toBe('safe');
    });

    it('passes through primitives unchanged', () => {
      expect(redactConfigValue('hello')).toBe('hello');
      expect(redactConfigValue(42)).toBe(42);
      expect(redactConfigValue(null)).toBeNull();
      expect(redactConfigValue(true)).toBe(true);
    });
  });

  describe('parameterStatusLabel', () => {
    it('returns Chinese label for known statuses', () => {
      expect(parameterStatusLabel('active')).toBe('生效中');
      expect(parameterStatusLabel('draft')).toBe('草稿');
      expect(parameterStatusLabel('retired')).toBe('已退役');
      expect(parameterStatusLabel('pending_approval')).toBe('待审批');
    });

    it('returns dash for null/undefined', () => {
      expect(parameterStatusLabel(null)).toBe('—');
      expect(parameterStatusLabel(undefined)).toBe('—');
    });

    it('falls back to raw value for unknown', () => {
      expect(parameterStatusLabel('custom')).toBe('custom');
    });
  });
});
