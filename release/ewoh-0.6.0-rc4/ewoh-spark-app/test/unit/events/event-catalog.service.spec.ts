import { EventCatalogService } from '@server/modules/events/event-catalog.service';

describe('EventCatalogService', () => {
  it('loads the AsyncAPI event catalog', () => {
    const service = new EventCatalogService();
    const catalog = service.getCatalog();

    expect(catalog.asyncapi).toBe('2.6.0');
    expect(catalog.info.title).toBe('EWOH Event Catalog');
    expect(Object.keys(catalog.channels).length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(catalog.components?.messages ?? {}).length).toBeGreaterThanOrEqual(
      13,
    );
  });

  it('returns a channel and CloudEvents metadata for an event type', () => {
    const service = new EventCatalogService();
    const result = service.getEventType('TelemetryObserved');

    expect(result.channel).toBe('telemetry.observed');
    expect(result.message).toMatchObject({
      name: 'TelemetryObserved',
      contentType: 'application/cloudevents+json',
    });
    expect(result.message).toHaveProperty('x-cloud-events.specversion', '1.0');
  });

  it('returns 404 semantics for unknown event types', () => {
    const service = new EventCatalogService();
    expect(() => service.getEventType('NoSuchEvent')).toThrow(
      'Event type NoSuchEvent not found',
    );
  });
});
