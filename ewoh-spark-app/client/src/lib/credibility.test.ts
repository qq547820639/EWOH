import {
  DEFAULT_STALE_THRESHOLD_MS,
  credibilitySummary,
  formatTimestamp,
  isDecisionEligible,
  isStale,
  percent,
} from './credibility';

const NOW = new Date('2026-08-05T12:00:00Z').getTime();
const fresh = '2026-08-05T11:59:00Z'; // 1 分钟前 → 未过期

describe('credibility (UX-001 数据可信度)', () => {
  it('marks data stale when lastSyncedAt is older than the threshold', () => {
    expect(isStale(fresh, NOW)).toBe(false);
    expect(isStale('2026-08-05T11:00:00Z', NOW)).toBe(true); // >5min
    expect(isStale(undefined, NOW)).toBe(true);
    expect(isStale('not-a-date', NOW)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isStale('2026-08-05T11:30:00Z', NOW, 60 * 60_000)).toBe(false);
    expect(isStale('2026-08-05T11:30:00Z', NOW, 60_000)).toBe(true);
  });

  it('flags offline-cache and simulated/replay state', () => {
    const s = credibilitySummary(
      { sourceType: 'replayed', lastSyncedAt: fresh, isSimulatedOrReplay: true },
      NOW,
    );
    expect(s.isSimulatedOrReplay).toBe(true);
    expect(
      credibilitySummary({ lastSyncedAt: fresh, isOfflineCache: true }, NOW).isOfflineCache,
    ).toBe(true);
  });

  it('decisionEligible=false for simulated/replayed data', () => {
    expect(
      isDecisionEligible({ lastSyncedAt: fresh, isSimulatedOrReplay: true }, NOW),
    ).toBe(false);
  });

  it('decisionEligible=false for stale data', () => {
    expect(isDecisionEligible({ lastSyncedAt: '2026-08-05T10:00:00Z' }, NOW)).toBe(false);
  });

  it('decisionEligible=false for incomplete data', () => {
    expect(isDecisionEligible({ lastSyncedAt: fresh, completeness: 0.7 }, NOW)).toBe(false);
  });

  it('decisionEligible=false for low-confidence data', () => {
    expect(isDecisionEligible({ lastSyncedAt: fresh, confidence: 0.5 }, NOW)).toBe(false);
  });

  it('decisionEligible=false for offline cache even when otherwise fresh', () => {
    expect(isDecisionEligible({ lastSyncedAt: fresh, isOfflineCache: true }, NOW)).toBe(false);
  });

  it('decisionEligible=true only for fresh, complete, confident, authorized data', () => {
    expect(
      isDecisionEligible(
        { lastSyncedAt: fresh, completeness: 1, confidence: 0.95, decisionAuthorized: true },
        NOW,
      ),
    ).toBe(true);
    expect(
      isDecisionEligible({ lastSyncedAt: fresh, completeness: 1, confidence: 0.95 }, NOW),
    ).toBe(true);
  });

  it('formats timestamps and percentages', () => {
    expect(formatTimestamp(undefined)).toBe('—');
    expect(formatTimestamp('garbage')).toBe('garbage');
    expect(percent(0.85)).toBe('85%');
    expect(percent(undefined)).toBe('—');
  });

  it('builds a complete credibility summary', () => {
    const s = credibilitySummary(
      {
        sourceType: 'real',
        collectedAt: fresh,
        lastSyncedAt: fresh,
        completeness: 1,
        confidence: 0.95,
      },
      NOW,
    );
    expect(s).toMatchObject({
      sourceType: 'real',
      isStale: false,
      isOfflineCache: false,
      isSimulatedOrReplay: false,
      completeness: 1,
      confidence: 0.95,
      decisionEligible: true,
    });
  });

  it('exposes the default stale threshold constant', () => {
    expect(DEFAULT_STALE_THRESHOLD_MS).toBe(5 * 60_000);
  });
});