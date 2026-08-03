export const PROGRESSIVE_STEP = 50;

export function progressiveSlice<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(1, limit));
}

export function hasMoreItems<T>(items: T[], limit: number): boolean {
  return items.length > Math.max(1, limit);
}

export function nextProgressiveLimit(current: number): number {
  return current + PROGRESSIVE_STEP;
}
