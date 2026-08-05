/**
 * UX-001 高对比模式 —— 检测 prefers-contrast: more 并切换 high-contrast 类。
 *
 * 纯函数模块：把「媒体查询匹配」「类切换」做成可注入、可单测的小函数。
 */

export type ContrastMode = 'high' | 'normal';

/** 媒体查询是否匹配 prefers-contrast: more。 */
export function prefersContrastMore(media?: { matches: boolean } | null): boolean {
  return Boolean(media?.matches);
}

/** 由媒体查询得出对比模式。 */
export function detectContrastMode(media?: { matches: boolean } | null): ContrastMode {
  return prefersContrastMore(media) ? 'high' : 'normal';
}

/**
 * 应用对比模式：为根元素切换 high-contrast 类并返回当前模式。
 * 缺省 root 时使用 document.documentElement（在非浏览器环境自动跳过）。
 */
export function applyContrastClass(
  media: { matches: boolean } | null,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): ContrastMode {
  const mode = detectContrastMode(media);
  if (root) {
    root.classList.toggle('high-contrast', mode === 'high');
  }
  return mode;
}