import { sanitizeLinkHref } from './link-edit-form';

describe('sanitizeLinkHref（CLI-302 tiptap 链接 href 白名单）', () => {
  it('accepts safe schemes and relative paths', () => {
    expect(sanitizeLinkHref('https://example.com/a')).toBe('https://example.com/a');
    expect(sanitizeLinkHref('http://example.com/a')).toBe('http://example.com/a');
    expect(sanitizeLinkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeLinkHref('/docs/page')).toBe('/docs/page');
    expect(sanitizeLinkHref('#anchor')).toBe('#anchor');
  });

  it('rejects dangerous schemes so applyLink never writes them into link marks', () => {
    expect(sanitizeLinkHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeLinkHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeLinkHref('data:text/html,<script>')).toBeNull();
    expect(sanitizeLinkHref('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeLinkHref('  javascript:alert(1)  ')).toBeNull();
    expect(sanitizeLinkHref('')).toBeNull();
  });
});
