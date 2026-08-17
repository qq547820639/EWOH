import {
  isSafeUrl,
  sanitizeUrl,
  isDownloadUrl,
  isSafeRedirectUrl,
} from './urlSafety';

describe('urlSafety isSafeUrl（链接 scheme 白名单）', () => {
  it('allows http/https/mailto/tel', () => {
    expect(isSafeUrl('https://example.com/a?b=1')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('mailto:user@example.com')).toBe(true);
    expect(isSafeUrl('tel:+8613800000000')).toBe(true);
  });

  it('rejects dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeUrl(' data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('filesystem:https://x/persistent/a')).toBe(false);
    // `&colon;` 是 HTML 实体，URL 解析器不解码——该串是相对路径，安全。
    expect(isSafeUrl('jAvAsCrIpT&colon;alert(1)')).toBe(true);
  });

  it('rejects control characters used to bypass prefix filters', () => {
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false);
    expect(isSafeUrl('java\tscript:alert(1)')).toBe(false);
    expect(isSafeUrl('javascript\x00:alert(1)')).toBe(false);
  });

  it('allows relative paths and anchors', () => {
    expect(isSafeUrl('/api/v1/things')).toBe(true);
    expect(isSafeUrl('detail/42')).toBe(true);
    expect(isSafeUrl('#section')).toBe(true);
    expect(isSafeUrl('?q=1')).toBe(true);
    expect(isSafeUrl('//cdn.example.com/lib.js')).toBe(true);
  });

  it('gates blob: behind explicit allowBlob', () => {
    expect(isSafeUrl('blob:https://example.com/uuid')).toBe(false);
    expect(isSafeUrl('blob:https://example.com/uuid', { allowBlob: true })).toBe(true);
  });

  it('rejects empty and non-string input', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
  });
});

describe('urlSafety sanitizeUrl', () => {
  it('returns trimmed url when safe', () => {
    expect(sanitizeUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('returns null when unsafe', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('data:text/html,x')).toBeNull();
  });
});

describe('urlSafety isDownloadUrl（附件下载校验）', () => {
  it('allows http/https/blob and relative paths', () => {
    expect(isDownloadUrl('https://example.com/f.zip')).toBe(true);
    expect(isDownloadUrl('http://example.com/f.zip')).toBe(true);
    expect(isDownloadUrl('blob:https://example.com/uuid')).toBe(true);
    expect(isDownloadUrl('/runtime/api/v1/storage/object/abc')).toBe(true);
  });

  it('rejects script-capable schemes', () => {
    expect(isDownloadUrl('javascript:alert(1)')).toBe(false);
    expect(isDownloadUrl('data:text/html,x')).toBe(false);
    expect(isDownloadUrl('vbscript:x')).toBe(false);
    expect(isDownloadUrl('filesystem:https://x/persistent/a')).toBe(false);
  });
});

describe('urlSafety isSafeRedirectUrl（重定向白名单）', () => {
  it('allows same-origin relative paths and anchors', () => {
    expect(isSafeRedirectUrl('/login')).toBe(true);
    expect(isSafeRedirectUrl('#/workbench')).toBe(true);
    expect(isSafeRedirectUrl('?next=/x')).toBe(true);
  });

  it('rejects protocol-relative and backslash tricks', () => {
    expect(isSafeRedirectUrl('//evil.com/login')).toBe(false);
    expect(isSafeRedirectUrl('\\/evil.com')).toBe(false);
    expect(isSafeRedirectUrl('/\\evil.com')).toBe(false);
  });

  it('allows allowlisted https origins (feishu/lark)', () => {
    expect(isSafeRedirectUrl('https://open.feishu.cn/a?b=1')).toBe(true);
    expect(isSafeRedirectUrl('https://accounts.larksuite.com/x')).toBe(true);
    expect(isSafeRedirectUrl('https://feishu.cn/x')).toBe(true);
  });

  it('rejects non-allowlisted or non-https absolute origins', () => {
    expect(isSafeRedirectUrl('https://evil.com/login')).toBe(false);
    expect(isSafeRedirectUrl('https://notfeishu.cn.evil.com/x')).toBe(false);
    expect(isSafeRedirectUrl('http://open.feishu.cn/x')).toBe(false);
    expect(isSafeRedirectUrl('javascript:alert(1)')).toBe(false);
  });
});
