/* ThemeToggle.tsx — 手动主题切换（NO-13f / ADR-055，§17 工厂操作台）。
 *
 * 三态循环（system → dark → light → system）；偏好持久化 localStorage
 * （contrastMode 单一事实源）；每次切换即时同步 data-theme（tokens.css
 * 暗色令牌生效）。图标+文字双重表达（ux009 工业 UX 纪律）。
 */
import { useState } from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import {
  applyThemePreference,
  getThemePreference,
  nextThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../../lib/contrastMode';

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色',
};

const ThemeToggle = (): React.ReactElement => {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference());

  const handleToggle = () => {
    const next = nextThemePreference(preference);
    setThemePreference(next);
    const media =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    applyThemePreference(next, media);
    setPreference(next);
  };

  const Icon = preference === 'system' ? Monitor : preference === 'dark' ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={handleToggle}
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-white/70 hover:bg-white/10 hover:text-white transition-colors"
      aria-label={`主题切换（当前：${THEME_PREFERENCE_LABELS[preference]}）`}
      title={`主题：${THEME_PREFERENCE_LABELS[preference]}（点击切换）`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span>{THEME_PREFERENCE_LABELS[preference]}</span>
    </button>
  );
};

export default ThemeToggle;
