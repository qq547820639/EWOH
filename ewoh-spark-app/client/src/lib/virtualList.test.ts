import { computeVirtualRange } from './virtualList';

describe('computeVirtualRange', () => {
  it('returns a stable window for a large list at the top', () => {
    const range = computeVirtualRange(5000, 400, 40, 0, 4);
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(30);
    expect(range.totalHeight).toBe(5000 * 40);
    expect(range.offsetY).toBe(0);
    expect(range.visibleCount).toBe(10);
  });

  it('shifts the window with scroll position', () => {
    const range = computeVirtualRange(5000, 400, 40, 1000, 4);
    expect(range.start).toBe(25 - 4); // floor(1000/40) - overscan
    expect(range.offsetY).toBe(range.start * 40);
    expect(range.end).toBeGreaterThan(range.start);
  });

  it('clamps the end to total', () => {
    const range = computeVirtualRange(10, 400, 40, 100000, 4);
    expect(range.end).toBe(10);
    expect(range.start).toBeLessThanOrEqual(10);
  });

  it('returns an empty window for zero total or zero viewport', () => {
    expect(computeVirtualRange(0, 400, 40, 0).end).toBe(0);
    expect(computeVirtualRange(100, 0, 40, 0).end).toBe(0);
    expect(computeVirtualRange(100, 0, 40, 0).totalHeight).toBe(100 * 40);
  });

  it('guards against non-positive item height', () => {
    expect(computeVirtualRange(100, 400, 0, 0).totalHeight).toBe(100);
  });
});