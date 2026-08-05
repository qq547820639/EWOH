import {
  buildTimelineEvent,
  buildTimelineEvents,
} from '../../../server/modules/timeline/timeline.projection';

describe('buildTimelineEvent (统一对象时间线投影)', () => {
  it('maps a domain event to the uniform DTO with defaults', () => {
    const out = buildTimelineEvent({
      id: 'e1',
      eventId: 'EV-001',
      createdAt: '2026-01-01T00:00:00Z',
      title: '过载',
      severity: 'L2',
      status: 'open',
      deviceId: 'dev-1',
      sourceType: 'simulated',
    });
    expect(out.id).toBe('e1');
    expect(out.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(out.actor).toBe('system');
    expect(out.source).toBe('simulated');
    expect(out.objectType).toBe('event');
    expect(out.objectId).toBe('dev-1');
    expect(out.action).toBe('updated');
    expect(out.previousState).toBeNull();
    expect(out.currentState).toBe('open');
    expect(out.correlationId).toBeNull();
    expect(out.causationId).toBeNull();
    expect(out.evidence).toEqual([]);
    expect(out.credibility.sourceType).toBe('simulated');
    expect(out.credibility.decisionAuthorized).toBe(true);
    expect(out.permissionVisibility).toBe('visible');
    expect(out.title).toBe('过载');
  });

  it('maps triggerRecordId and object-form evidenceJson', () => {
    const out = buildTimelineEvent({
      id: 'e2',
      eventId: 'EV-002',
      deviceId: 'dev-2',
      eventType: 'overload',
      triggerRecordId: 'rec-9',
      evidenceJson: { load_score: '0.95' },
    });
    expect(out.correlationId).toBe('rec-9');
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0].id).toBe('load_score');
    expect(out.evidence[0].ref).toBe('0.95');
  });

  it('uses sourceType as credibility source and array evidence as-is', () => {
    const out = buildTimelineEvent({
      id: 'e3',
      sourceType: 'real',
      evidence: [{ id: 'ev-ref', type: 'telemetry' }],
    });
    expect(out.source).toBe('real');
    expect(out.credibility.sourceType).toBe('real');
    expect(out.evidence).toEqual([{ id: 'ev-ref', type: 'telemetry' }]);
  });
});

describe('buildTimelineEvents (批量)', () => {
  it('projects a list and preserves order', () => {
    const out = buildTimelineEvents([
      { id: 'a', eventId: 'A' },
      { id: 'b', eventId: 'B' },
    ]);
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
  });
});
