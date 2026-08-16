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

/**
 * NO-13f / ADR-055：手动主题切换（偏好持久化 + 系统/明/暗三态循环）。
 * 偏好为单一事实源（localStorage 'ewoh.theme'），'system' = 跟随系统媒体查询。
 */
export type ThemePreference = 'system' | ThemeMode;

export const THEME_STORAGE_KEY = 'ewoh.theme';

type ThemeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

function defaultStorage(): ThemeStorage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/** 读取主题偏好（非法值/缺失 → 'system'；非浏览器环境安全）。 */
export function getThemePreference(storage?: ThemeStorage | null): ThemePreference {
  const store = storage !== undefined ? storage : defaultStorage();
  const value = store?.getItem(THEME_STORAGE_KEY) ?? null;
  return value === 'dark' || value === 'light' ? value : 'system';
}

/** 持久化主题偏好（'system' 时移除键——显式默认，不落脏值）。 */
export function setThemePreference(preference: ThemePreference, storage?: ThemeStorage | null): void {
  const store = storage !== undefined ? storage : defaultStorage();
  if (!store) return;
  if (preference === 'system') {
    store.removeItem(THEME_STORAGE_KEY);
  } else {
    store.setItem(THEME_STORAGE_KEY, preference);
  }
}

/** 偏好 → 实际主题（system 跟随媒体查询）。 */
export function resolveThemeMode(preference: ThemePreference, media?: { matches: boolean } | null): ThemeMode {
  return preference === 'system' ? detectThemeMode(media) : preference;
}

/** 应用偏好并同步 data-theme；返回实际主题。 */
export function applyThemePreference(
  preference: ThemePreference,
  media?: { matches: boolean } | null,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): ThemeMode {
  const mode = resolveThemeMode(preference, media);
  syncDataAttribute(root, 'data-theme', mode);
  return mode;
}

/** 三态循环（system → dark → light → system）。 */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === 'system') return 'dark';
  if (current === 'dark') return 'light';
  return 'system';
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