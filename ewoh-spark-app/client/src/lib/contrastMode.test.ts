import {
  applyContrastClass,
  applyDarkClass,
  applyThemePreference,
  detectContrastMode,
  detectThemeMode,
  getThemePreference,
  nextThemePreference,
  prefersContrastMore,
  prefersDark,
  prefersReducedMotion,
  resolveThemeMode,
  setThemePreference
} from './contrastMode';

/** 最小可用的 classList + data 属性 伪造（jest 环境为 node，无真实 DOM）。 */
function fakeRoot(attrs: Record<string, string> = {}) {
  const classes = new Set<string>();
  const data = new Map<string, string>(Object.entries(attrs));
  return {
    classList: {
      toggle: (cls: string, force: boolean) => {
        if (force) classes.add(cls);
        else classes.delete(cls);
      },
      contains: (cls: string) => classes.has(cls),
    },
    setAttribute: (name: string, value: string) => data.set(name, value),
    removeAttribute: (name: string) => data.delete(name),
    getAttribute: (name: string) => data.get(name) ?? null,
  } as unknown as HTMLElement;
}

describe('contrastMode (UX-001 高对比模式)', () => {
  it('detects prefers-contrast: more media query matching', () => {
    expect(prefersContrastMore({ matches: true })).toBe(true);
    expect(prefersContrastMore({ matches: false })).toBe(false);
    expect(prefersContrastMore(null)).toBe(false);
    expect(prefersContrastMore(undefined)).toBe(false);
  });

  it('maps to high/normal mode', () => {
    expect(detectContrastMode({ matches: true })).toBe('high');
    expect(detectContrastMode({ matches: false })).toBe('normal');
  });

  it('toggles the high-contrast class on the root element', () => {
    const root = fakeRoot();
    expect(applyContrastClass({ matches: true }, root)).toBe('high');
    expect(root.classList.contains('high-contrast')).toBe(true);
    expect(applyContrastClass({ matches: false }, root)).toBe('normal');
    expect(root.classList.contains('high-contrast')).toBe(false);
  });

  it('returns the mode without touching a null root', () => {
    expect(applyContrastClass({ matches: true }, null)).toBe('high');
  });
});
describe('theme preference（NO-13f / ADR-055 手动主题切换）', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it('getThemePreference：dark/light 持久化读回；非法/缺失 → system', () => {
    expect(getThemePreference(fakeStorage({ 'ewoh.theme': 'dark' }))).toBe('dark');
    expect(getThemePreference(fakeStorage({ 'ewoh.theme': 'light' }))).toBe('light');
    expect(getThemePreference(fakeStorage({ 'ewoh.theme': 'turbo' }))).toBe('system');
    expect(getThemePreference(fakeStorage())).toBe('system');
    expect(getThemePreference(null)).toBe('system');
  });

  it('setThemePreference：dark/light 写入；system 移除键（显式默认不落脏值）', () => {
    const store = fakeStorage();
    setThemePreference('dark', store);
    expect(store.getItem('ewoh.theme')).toBe('dark');
    setThemePreference('system', store);
    expect(store.getItem('ewoh.theme')).toBeNull();
  });

  it('resolveThemeMode：system 跟随媒体查询；dark/light 显式优先', () => {
    expect(resolveThemeMode('system', { matches: true })).toBe('dark');
    expect(resolveThemeMode('system', { matches: false })).toBe('light');
    expect(resolveThemeMode('dark', { matches: false })).toBe('dark');
    expect(resolveThemeMode('light', { matches: true })).toBe('light');
  });

  it('nextThemePreference：三态循环 system → dark → light → system', () => {
    expect(nextThemePreference('system')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('light');
    expect(nextThemePreference('light')).toBe('system');
  });

  it('applyThemePreference：同步 data-theme 且返回实际主题', () => {
    const root = fakeRoot();
    const mode = applyThemePreference('dark', { matches: false }, root);
    expect(mode).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});
