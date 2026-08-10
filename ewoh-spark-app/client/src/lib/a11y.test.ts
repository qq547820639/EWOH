import {
  FOCUS_RING,
  MIN_NON_TEXT_CONTRAST,
  MIN_TEXT_CONTRAST,
  MUTED_FOREGROUND,
  UI_ARIA_LABELS,
  contrastRatio,
  eventAccessibleLabel,
  focusOrderIsContiguous,
  hasNonColorChannel,
  isReadableText,
  reachableFocusCount,
  relativeLuminance,
  statusesMissingNonColorChannel,
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

  it('Task 12：Command Map 键盘可达标签齐备（表格视图切换/覆盖层关闭/分配）', () => {
    expect(UI_ARIA_LABELS.switchTableView).toBe('切换到表格视图');
    expect(UI_ARIA_LABELS.switchCardView).toBe('切换到列表视图');
    expect(UI_ARIA_LABELS.closeConflictPreview).toBe('关闭冲突处置工作台');
    expect(UI_ARIA_LABELS.closePlanDiff).toBe('关闭变更详情');
    expect(UI_ARIA_LABELS.closeIntelligencePanel).toBe('关闭智能调度驾驶舱');
    expect(UI_ARIA_LABELS.assignResource).toBe('分配资源到工位');
  });

  it('Task 12：Command Map 状态具备非颜色信道（1.4.1 不只靠颜色）', () => {
    // 新鲜度（文本标签 + tooltip）、冲突严重度（文本）、生命周期状态（文本）、
    // 资源状态（文本）、方案状态（文本）——全部含文本信道。
    const missing = statusesMissingNonColorChannel([
      // dataFreshness：LIVE/DELAYED/STALE/OFFLINE/REPLAY/SHADOW/RESYNCING/DEGRADED
      { status: 'LIVE', hasText: true, hasIcon: false, hasAria: true },
      { status: 'STALE', hasText: true, hasIcon: false, hasAria: true },
      { status: 'OFFLINE', hasText: true, hasIcon: false, hasAria: true },
      { status: 'RESYNCING', hasText: true, hasIcon: false, hasAria: true },
      // 冲突严重度 / 生命周期
      { status: 'high', hasText: true, hasIcon: false, hasAria: false },
      { status: 'OPEN', hasText: true, hasIcon: false, hasAria: false },
      { status: 'RESOLVED', hasText: true, hasIcon: false, hasAria: false },
      // 资源 / 任务 / 方案状态
      { status: 'online', hasText: true, hasIcon: false, hasAria: false },
      { status: 'busy', hasText: true, hasIcon: false, hasAria: false },
      { status: 'blocked', hasText: true, hasIcon: false, hasAria: false },
      { status: 'approved', hasText: true, hasIcon: false, hasAria: false },
      // 瓶颈（图标 + 文本）
      { status: 'bottleneck', hasText: true, hasIcon: true, hasAria: false },
    ]);
    expect(missing).toEqual([]);
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

describe('reachable focus (可为页面验证的焦点顺序断言)', () => {
  it('accepts a contiguous natural tab order', () => {
    expect(
      focusOrderIsContiguous([
        { tabIndex: 0 },
        { tabIndex: 1 },
        { tabIndex: 2 },
      ]),
    ).toBe(true);
  });

  it('rejects gaps, negatives, or empty order', () => {
    expect(focusOrderIsContiguous([{ tabIndex: 0 }, { tabIndex: 2 }])).toBe(false);
    expect(focusOrderIsContiguous([{ tabIndex: -1 }, { tabIndex: 0 }])).toBe(false);
    expect(focusOrderIsContiguous([])).toBe(false);
  });

  it('counts only reachable (non-disabled/hidden, tabIndex>=0) elements', () => {
    expect(
      reachableFocusCount([
        { tabIndex: 0 },
        { tabIndex: 1, disabled: true },
        { tabIndex: 2, hidden: true },
        { tabIndex: -1 },
      ]),
    ).toBe(1);
  });
});

describe('非颜色唯一表达 (1.4.1)', () => {
  it('accepts a status that carries text or icon in addition to color', () => {
    expect(hasNonColorChannel({ status: 'failed', hasText: true, hasIcon: false, hasAria: false })).toBe(true);
    expect(hasNonColorChannel({ status: 'online', hasText: false, hasIcon: true, hasAria: false })).toBe(true);
    expect(hasNonColorChannel({ status: 'offline', hasText: false, hasIcon: false, hasAria: true })).toBe(true);
  });

  it('flags a status conveyed only by color', () => {
    expect(hasNonColorChannel({ status: 'warning', hasText: false, hasIcon: false, hasAria: false })).toBe(false);
  });

  it('reports every status missing a non-color channel', () => {
    const missing = statusesMissingNonColorChannel([
      { status: 'ok', hasText: true, hasIcon: false, hasAria: false },
      { status: 'warn', hasText: false, hasIcon: false, hasAria: false },
      { status: 'err', hasText: false, hasIcon: true, hasAria: false },
    ]);
    expect(missing).toEqual(['warn']);
  });
});
