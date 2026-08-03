import { summarizeReplayContext } from './replayContext';

describe('summarizeReplayContext', () => {
  it('extracts before/during/after timestamps and event count', () => {
    const summary = summarizeReplayContext({
      before: { ts: '2026-08-04T09:55:00.000Z' },
      during: { ts: '2026-08-04T10:00:00.000Z' },
      after: { ts: '2026-08-04T10:05:00.000Z' },
      timelineCount: 12,
    });
    expect(summary).toEqual({
      beforeTs: '2026-08-04T09:55:00.000Z',
      duringTs: '2026-08-04T10:00:00.000Z',
      afterTs: '2026-08-04T10:05:00.000Z',
      timelineCount: 12,
    });
  });

  it('handles missing snapshots', () => {
    const summary = summarizeReplayContext({ timelineCount: 0 });
    expect(summary.beforeTs).toBeNull();
    expect(summary.duringTs).toBeNull();
    expect(summary.afterTs).toBeNull();
  });
});
