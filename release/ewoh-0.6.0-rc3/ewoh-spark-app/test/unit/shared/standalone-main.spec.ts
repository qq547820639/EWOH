import {
  applySecurityHeaders,
  corsOrigins,
  isSpaFallbackPath,
  trustProxySetting,
} from '../../../server/standalone-main';

describe('standalone bootstrap security configuration', () => {
  it('disables cross-origin access by default', () => {
    expect(corsOrigins('')).toBe(false);
  });

  it('parses explicit origins and rejects a wildcard', () => {
    expect(corsOrigins('https://one.example, https://two.example')).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
    expect(() => corsOrigins('*')).toThrow();
  });

  it('trusts one proxy hop by default', () => {
    expect(trustProxySetting('')).toBe(1);
  });

  it('accepts an explicit hop count or CIDR list and rejects unlimited trust', () => {
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('10.0.0.0/8, 192.168.0.0/16')).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
    ]);
    expect(() => trustProxySetting('true')).toThrow();
  });

  it('applies browser security headers', () => {
    const headers: Record<string, string> = {};
    applySecurityHeaders({
      setHeader: (name, value) => {
        headers[name] = value;
      },
    });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['X-XSS-Protection']).toBe('0');
  });

  it('keeps API, health, and metrics routes out of the SPA fallback', () => {
    expect(isSpaFallbackPath('/login')).toBe(true);
    expect(isSpaFallbackPath('/command-map')).toBe(true);
    expect(isSpaFallbackPath('/api/organization')).toBe(false);
    expect(isSpaFallbackPath('/health/live')).toBe(false);
    expect(isSpaFallbackPath('/metrics')).toBe(false);
  });
});
