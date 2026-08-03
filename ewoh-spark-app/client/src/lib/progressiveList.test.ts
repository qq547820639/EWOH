import {
  hasMoreItems,
  nextProgressiveLimit,
  progressiveSlice,
} from './progressiveList';

describe('progressive list helpers', () => {
  it('slices arrays progressively and reports whether more remain', () => {
    const items = Array.from({ length: 120 }, (_, index) => index);
    expect(progressiveSlice(items, 50)).toHaveLength(50);
    expect(hasMoreItems(items, 50)).toBe(true);
    expect(progressiveSlice(items, 150)).toHaveLength(120);
    expect(hasMoreItems(items, 150)).toBe(false);
  });

  it('advances the visible limit by a fixed step', () => {
    expect(nextProgressiveLimit(50)).toBe(100);
    expect(nextProgressiveLimit(100)).toBe(150);
  });
});
