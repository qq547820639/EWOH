/* ThemeToggle 渲染 smoke（NO-13f / ADR-055：手动主题切换组件）。 */
import { renderToStaticMarkup } from 'react-dom/server';
import ThemeToggle, { THEME_PREFERENCE_LABELS } from './ThemeToggle';
import { THEME_STORAGE_KEY } from '../../lib/contrastMode';

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('ThemeToggle 渲染 smoke（NO-13f / ADR-055）', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('默认（无偏好）→ 跟随系统标签', () => {
    const markup = renderToStaticMarkup(<ThemeToggle />);
    expect(markup).toContain(THEME_PREFERENCE_LABELS.system);
    expect(markup).toContain('主题切换');
  });

  it('持久化偏好 dark → 深色标签（单一事实源读回）', () => {
    (globalThis as Record<string, unknown>).localStorage = fakeLocalStorage({
      [THEME_STORAGE_KEY]: 'dark',
    });
    const markup = renderToStaticMarkup(<ThemeToggle />);
    expect(markup).toContain(THEME_PREFERENCE_LABELS.dark);
  });

  it('持久化偏好 light → 浅色标签', () => {
    (globalThis as Record<string, unknown>).localStorage = fakeLocalStorage({
      [THEME_STORAGE_KEY]: 'light',
    });
    const markup = renderToStaticMarkup(<ThemeToggle />);
    expect(markup).toContain(THEME_PREFERENCE_LABELS.light);
  });
});
