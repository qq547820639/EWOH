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

const ThemeToggle = ({ compact = false }: { compact?: boolean }): React.ReactElement => {
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
      /* R2-CC2-002：按钮位于侧栏 footer（bg-card 令牌表面），前景改配对令牌
       * （原 text-white/70 在浅色白底上白字近乎不可见；dark 下 hover 也不可读）。 */
      className={
        compact
          ? /* 2026-08-18：compact 模式用于指挥地图顶栏——icon-only，浅色下暗字/深色下亮字，
              不显示"浅色/深色"文字（ux009 语义经 title 保留）。 */
            'flex items-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
          : 'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
      }
      aria-label={`主题切换（当前：${THEME_PREFERENCE_LABELS[preference]}）`}
      title={`主题：${THEME_PREFERENCE_LABELS[preference]}（点击切换）`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {!compact && <span>{THEME_PREFERENCE_LABELS[preference]}</span>}
    </button>
  );
};

export default ThemeToggle;
