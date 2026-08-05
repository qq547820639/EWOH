/**
 * UX-001 高对比模式 —— 检测 prefers-contrast: more 并切换 high-contrast 类 / data-contrast 属性。
 * UX-00X 暗色模式与减少动效 —— 提供 data-theme 与 prefers-reduced-motion 助手。
 *
 * 纯函数模块：把「媒体查询匹配」「DOM 切换」做成可注入、可单测的小函数。
 */

export type ContrastMode = 'high' | 'normal';
export type ThemeMode = 'dark' | 'light';

/** 媒体查询是否匹配 prefers-contrast: more。 */
export function prefersContrastMore(media?: { matches: boolean } | null): boolean {
  return Boolean(media?.matches);
}

/** 由媒体查询得出对比模式。 */
export function detectContrastMode(media?: { matches: boolean } | null): ContrastMode {
  return prefersContrastMore(media) ? 'high' : 'normal';
}

/**
 * 应用对比模式：为根元素切换 high-contrast 类并同步 data-contrast 属性，返回当前模式。
 * 缺省 root 时使用 document.documentElement（在非浏览器环境自动跳过）。
 */
export function applyContrastClass(
  media: { matches: boolean } | null,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): ContrastMode {
  const mode = detectContrastMode(media);
  if (root) {
    root.classList.toggle('high-contrast', mode === 'high');
    syncDataAttribute(root, 'data-contrast', mode === 'high' ? 'high' : null);
  }
  return mode;
}

/**
 * 暗色模式：检测 prefers-color-scheme: dark 并同步 data-theme 属性，返回当前模式。
 * 缺省 root 时使用 document.documentElement（在非浏览器环境自动跳过）。
 */
export function prefersDark(media?: { matches: boolean } | null): boolean {
  return Boolean(media?.matches);
}

/** 由媒体查询得出主题模式。 */
export function detectThemeMode(media?: { matches: boolean } | null): ThemeMode {
  return prefersDark(media) ? 'dark' : 'light';
}

/** 应用主题模式：为根元素设置 data-theme="dark"|"light"。 */
export function applyDarkClass(
  media: { matches: boolean } | null,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): ThemeMode {
  const mode = detectThemeMode(media);
  if (root) {
    syncDataAttribute(root, 'data-theme', mode === 'dark' ? 'dark' : 'light');
  }
  return mode;
}

/** 是否匹配 prefers-reduced-motion: reduce。 */
export function prefersReducedMotion(media?: { matches: boolean } | null): boolean {
  return Boolean(media?.matches);
}

/** 通用：在根元素上设置/移除 data 属性，避免在无 DOM 的测试环境抛错。 */
function syncDataAttribute(root: HTMLElement, name: string, value: string | null): void {
  const el = root as HTMLElement & { setAttribute?: (n: string, v: string) => void; removeAttribute?: (n: string) => void };
  if (typeof el.setAttribute !== 'function') return;
  if (value === null) {
    el.removeAttribute?.(name);
  } else {
    el.setAttribute(name, value);
  }
}