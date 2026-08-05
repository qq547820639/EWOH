import { applyContrastClass, detectContrastMode, prefersContrastMore } from './contrastMode';

/** 最小可用的 classList 伪造（jest 环境为 node，无真实 DOM）。 */
function fakeRoot() {
  const classes = new Set<string>();
  return {
    classList: {
      toggle: (cls: string, force: boolean) => {
        if (force) classes.add(cls);
        else classes.delete(cls);
      },
      contains: (cls: string) => classes.has(cls),
    },
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