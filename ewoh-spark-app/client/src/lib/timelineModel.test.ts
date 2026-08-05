import {
  normalizeTimelineEvent,
  filterTimelineEvents,
  buildCorrelationChain,
  selectVisibleEvents,
  type TimelineEventModel,
} from './timelineModel';

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

describe('normalizeTimelineEvent', () => {
  it('fills missing fields with safe defaults', () => {
    const e = normalizeTimelineEvent({ id: 'evt-1' });
    expect(e.id).toBe('evt-1');
    expect(e.actor).toBe('system');
    expect(e.source).toBe('system');
    expect(e.objectType).toBe('event');
    expect(e.objectId).toBe('evt-1');
    expect(e.action).toBe('updated');
    expect(e.previousState).toBeNull();
    expect(e.currentState).toBeNull();
    expect(e.correlationId).toBeNull();
    expect(e.causationId).toBeNull();
    expect(e.evidence).toEqual([]);
    expect(e.credibility.decisionAuthorized).toBe(true);
    expect(e.permissionVisibility).toBe('visible');
  });

  it('uses createdAt as fallback timestamp and maps object evidence', () => {
    const e = normalizeTimelineEvent({
      id: 'evt-2',
      createdAt: '2026-02-02T00:00:00Z',
      eventType: 'overload',
      source: 'device',
      evidence: { load_score: '0.95', snapshot_ref: 'rec-1' },
    });
    expect(e.timestamp).toBe('2026-02-02T00:00:00Z');
    expect(e.action).toBe('overload');
    expect(e.source).toBe('device');
    expect(e.evidence).toHaveLength(2);
    expect(e.evidence[0].id).toBe('load_score');
  });
});

describe('filterTimelineEvents', () => {
  const events = [
    ev({ id: 'a', objectType: 'alert', riskLevel: 'high', actor: 'alice', timestamp: '2026-01-01T00:00:00Z' }),
    ev({ id: 'b', objectType: 'task', riskLevel: 'low', actor: 'bob', timestamp: '2026-01-02T00:00:00Z' }),
    ev({ id: 'c', objectType: 'alert', riskLevel: 'medium', actor: 'alice', timestamp: '2026-01-03T00:00:00Z' }),
  ];

  it('filters by objectType + riskLevel + actor', () => {
    const res = filterTimelineEvents(events, {
      objectType: 'alert',
      riskLevel: 'high',
      actor: 'alice',
    });
    expect(res.map((e) => e.id)).toEqual(['a']);
  });

  it('filters by time range (inclusive)', () => {
    const res = filterTimelineEvents(events, {
      from: '2026-01-02T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    });
    expect(res.map((e) => e.id)).toEqual(['b']);
  });

  it('returns all when filter is empty', () => {
    expect(filterTimelineEvents(events, {})).toHaveLength(3);
  });

  it('does not mutate the input array', () => {
    const before = events.length;
    filterTimelineEvents(events, { objectType: 'task' });
    expect(events).toHaveLength(before);
  });
});

describe('buildCorrelationChain', () => {
  it('returns empty when start id is unknown', () => {
    expect(buildCorrelationChain([ev({ id: 'x' })], 'missing')).toEqual([]);
  });

  it('traces alert→decision→command→execution→receipt→review via correlationId', () => {
    const events = [
      ev({ id: 'alert-1', action: 'triggered', timestamp: '2026-01-01T00:00:00Z' }),
      ev({ id: 'decision-1', action: 'decided', correlationId: 'alert-1', timestamp: '2026-01-01T00:00:01Z' }),
      ev({ id: 'command-1', action: 'dispatched', correlationId: 'decision-1', timestamp: '2026-01-01T00:00:02Z' }),
      ev({ id: 'execution-1', action: 'executed', correlationId: 'command-1', timestamp: '2026-01-01T00:00:03Z' }),
      ev({ id: 'receipt-1', action: 'received', correlationId: 'execution-1', timestamp: '2026-01-01T00:00:04Z' }),
      ev({ id: 'review-1', action: 'reviewed', correlationId: 'receipt-1', timestamp: '2026-01-01T00:00:05Z' }),
      ev({ id: 'unrelated', action: 'other', timestamp: '2026-01-01T00:00:06Z' }),
    ];
    const chain = buildCorrelationChain(events, 'alert-1');
    expect(chain.map((e) => e.action)).toEqual([
      'triggered',
      'decided',
      'dispatched',
      'executed',
      'received',
      'reviewed',
    ]);
  });

  it('follows causationId links and sorts by timestamp', () => {
    const events = [
      ev({ id: 'p', action: 'parent', timestamp: '2026-01-01T00:00:00Z' }),
      ev({ id: 'later', action: 'child', causationId: 'p', timestamp: '2026-01-01T00:00:10Z' }),
    ];
    const chain = buildCorrelationChain(events, 'p');
    expect(chain.map((e) => e.id)).toEqual(['p', 'later']);
  });
});

describe('selectVisibleEvents', () => {
  const events = [
    ev({ id: 'v', permissionVisibility: 'visible' }),
    ev({ id: 'r', permissionVisibility: 'restricted' }),
    ev({ id: 'h', permissionVisibility: 'hidden' }),
  ];

  it('keeps only visible by default', () => {
    expect(selectVisibleEvents(events).map((e) => e.id)).toEqual(['v']);
  });

  it('keeps allowed set when provided', () => {
    expect(
      selectVisibleEvents(events, ['visible', 'restricted']).map((e) => e.id),
    ).toEqual(['v', 'r']);
  });
});