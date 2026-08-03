import {
  FOCUS_RING,
  MIN_NON_TEXT_CONTRAST,
  MIN_TEXT_CONTRAST,
  MUTED_FOREGROUND,
  UI_ARIA_LABELS,
  contrastRatio,
  eventAccessibleLabel,
  isReadableText,
  relativeLuminance,
} from './a11y';

describe('a11y labels', () => {
  it('exposes a non-empty, unique label for every icon-only control', () => {
    const values = Object.values(UI_ARIA_LABELS);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value.trim().length > 0)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it('builds descriptive event labels for timeline markers', () => {
    expect(eventAccessibleLabel('设备离线', 'L3')).toBe(
      '设备离线，L3 级事件，点击查看详情',
    );
  });
});

describe('contrast tokens', () => {
  it('computes WCAG relative luminance and contrast ratio', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('muted foreground is readable on white and light card backgrounds', () => {
    expect(contrastRatio(MUTED_FOREGROUND, '#ffffff')).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
    expect(contrastRatio(MUTED_FOREGROUND, 'hsl(220 14% 96%)')).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST,
    );
    expect(isReadableText(MUTED_FOREGROUND, '#ffffff')).toBe(true);
  });

  it('focus ring meets non-text contrast on light and dark surfaces', () => {
    expect(contrastRatio(FOCUS_RING, '#ffffff')).toBeGreaterThanOrEqual(
      MIN_NON_TEXT_CONTRAST,
    );
    expect(contrastRatio(FOCUS_RING, 'hsl(220 14% 10%)')).toBeGreaterThanOrEqual(
      MIN_NON_TEXT_CONTRAST,
    );
    expect(contrastRatio(FOCUS_RING, 'hsl(220 14% 14%)')).toBeGreaterThanOrEqual(
      MIN_NON_TEXT_CONTRAST,
    );
  });
});
