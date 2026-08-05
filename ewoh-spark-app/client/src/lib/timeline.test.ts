import {
  normalizeTimelineEvent,
  filterTimelineEvents,
  buildCorrelationChain,
  selectVisibleEvents,
  type TimelineEventModel,
} from './timeline';

const ev = (over: Partial<TimelineEventModel> & { id: string }): TimelineEventModel => ({
  timestamp: '2026-01-01T00:00:00Z',
  actor: 'system',
  source: 'alert',
  objectType: 'alert',
  objectId: over.id,
  action: 'triggered',
  previousState: null,
  currentState: 'open',
  correlationId: null,
  causationId: null,
  evidence: [],
  credibility: { sourceType: 'real', decisionAuthorized: true },
  permissionVisibility: 'visible',
  ...over,
});

describe('timeline facade (re-export from timelineModel)', () => {
  it('normalizeTimelineEvent produces a uniform event', () => {
    const e = normalizeTimelineEvent({ id: 'evt-1', source: 'device' });
    expect(e.source).toBe('device');
    expect(e.objectType).toBe('event');
  });

  it('filterTimelineEvents applies filters', () => {
    const events = [
      ev({ id: 'high', riskLevel: 'high' }),
      ev({ id: 'low', riskLevel: 'low' }),
    ];
    expect(filterTimelineEvents(events, { riskLevel: 'high' }).map((e) => e.id)).toEqual([
      'high',
    ]);
  });

  it('buildCorrelationChain traces a chain', () => {
    const events = [
      ev({ id: 'a', action: 'triggered' }),
      ev({ id: 'b', action: 'handled', correlationId: 'a' }),
    ];
    expect(buildCorrelationChain(events, 'a').map((e) => e.action)).toEqual([
      'triggered',
      'handled',
    ]);
  });

  it('selectVisibleEvents filters by visibility', () => {
    const events = [ev({ id: 'v' }), ev({ id: 'h', permissionVisibility: 'hidden' })];
    expect(selectVisibleEvents(events).map((e) => e.id)).toEqual(['v']);
  });
});