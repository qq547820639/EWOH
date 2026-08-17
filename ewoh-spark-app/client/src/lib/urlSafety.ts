/**
 * URL scheme 白名单工具（审计 CLI-301/302/401/402/403/408/205 修复）。
 *
 * 统一拦截 `javascript:` / `data:` / `vbscript:` 等危险协议注入面：
 * 所有把不可信字符串渲染为 <a href> / window.open / location.replace 的
 * sink 必须先经 isSafeUrl / sanitizeUrl / isDownloadUrl / isSafeRedirectUrl
 * 校验，不安全时降级为纯文本或不执行导航。
 */

/** 允许渲染为可点击链接的协议（mailto/tel 为合法非脚本协议）。 */
const SAFE_LINK_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel']);

export interface SafeUrlOptions {
  /** blob: 仅在调用方明确声明（如附件下载预签名场景）时放行。 */
  allowBlob?: boolean;
}

/** 提取 URL scheme（无 scheme 的相对路径/锚点返回 null）。 */
function extractScheme(url: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 判断 URL 是否可安全渲染/导航：仅允许 http/https/mailto/tel，
 * 相对路径与锚点放行；blob: 仅在显式 allowBlob 时放行。
 */
export function isSafeUrl(
  url: string | null | undefined,
  options: SafeUrlOptions = {},
): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // 控制字符可用于绕过基于字符串前缀的过滤器（如 "java\nscript:"），直接拒绝。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;

  const scheme = extractScheme(trimmed);
  if (scheme === null) {
    // 相对路径（含协议相对 //host）或锚点：无脚本执行语义，放行。
    return true;
  }
  if (scheme === 'blob') {
    return options.allowBlob === true;
  }
  return SAFE_LINK_PROTOCOLS.has(scheme);
}

/**
 * 安全时返回规范化后的 URL，不安全时返回 null（调用方应降级为纯文本）。
 */
export function sanitizeUrl(
  url: string | null | undefined,
  options?: SafeUrlOptions,
): string | null {
  if (!isSafeUrl(url, options)) return null;
  return (url as string).trim();
}

/**
 * 附件下载/预览 URL 校验（CLI-402/403）：仅允许 http/https/blob，
 * 相对路径按页面 origin 解析后必为 http(s)，放行。
 */
export function isDownloadUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  const scheme = extractScheme(trimmed);
  if (scheme === null) return true;
  return scheme === 'http' || scheme === 'https' || scheme === 'blob';
}

/** redirectURL 外部重定向目标域白名单（飞书 H5 授权跳转域）。 */
const REDIRECT_HOST_ALLOWLIST = ['feishu.cn', 'larksuite.com'];

/**
 * 外部重定向 URL 校验（CLI-408）：仅允许同源相对路径或白名单 https origin。
 * 拒绝协议相对 URL（//host）、反斜杠 tricks 与非白名单绝对地址。
 */
export function isSafeRedirectUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  // 协议相对（//evil.com）与反斜杠（\/evil.com、/\/evil.com）一律拒绝。
  if (trimmed.startsWith('//') || trimmed.startsWith('\\')) return false;

  const scheme = extractScheme(trimmed);
  if (scheme === null) {
    // 反斜杠会被浏览器规范化为路径分隔符（"/\evil.com" → "//evil.com"
    // 即协议相对跨站跳转），一律拒绝。
    if (trimmed.includes('\\')) return false;
    // 同源相对路径必须以 / # ? 开头，其余（裸单词）按相对文档路径放行会
    // 依赖当前路由，为收敛起见拒绝。
    return trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?');
  }
  if (scheme !== 'https') return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (typeof window !== 'undefined' && parsed.origin === window.location.origin) {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  return REDIRECT_HOST_ALLOWLIST.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}
