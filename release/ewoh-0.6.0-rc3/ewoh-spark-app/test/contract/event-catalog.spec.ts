import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

interface EventCatalog {
  asyncapi: string;
  info?: {
    title?: string;
    version?: string;
  };
  'x-event-types'?: string[];
  channels?: Record<
    string,
    {
      publish?: { message?: { $ref?: string } };
      subscribe?: { message?: { $ref?: string } };
    }
  >;
  components?: {
    messages?: Record<
      string,
      {
        name?: string;
        contentType?: string;
        'x-cloud-events'?: {
          specversion?: string;
          type?: string;
          source?: string;
        };
        payload?: {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }
    >;
  };
}

describe('EWOH AsyncAPI/CloudEvents catalog contract', () => {
  const catalog = load(
    readFileSync(
      resolve(process.cwd(), '../contracts/events/event-catalog.yaml'),
      'utf8',
    ),
  ) as EventCatalog;

  it('is a valid AsyncAPI 2.6 document with metadata', () => {
    expect(catalog.asyncapi).toBe('2.6.0');
    expect(catalog.info?.title).toBe('EWOH Event Catalog');
    expect(catalog.info?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(catalog.channels ?? {}).length).toBeGreaterThan(0);
  });

  it('lists exactly the defined message types and keeps them unique', () => {
    const messages = Object.keys(catalog.components?.messages ?? {});
    expect(catalog['x-event-types']).toEqual(messages);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('resolves every channel message reference', () => {
    for (const [channel, value] of Object.entries(catalog.channels ?? {})) {
      const ref = value?.publish?.message?.$ref ?? value?.subscribe?.message?.$ref;
      expect(ref).toMatch(/^#\/components\/messages\/[A-Za-z0-9]+$/);
      const type = ref?.split('/').pop() ?? '';
      expect(catalog.components?.messages).toHaveProperty(type);
    }
  });

  it('requires CloudEvents 1.0 metadata on every message', () => {
    for (const [type, message] of Object.entries(catalog.components?.messages ?? {})) {
      expect(message.name).toBe(type);
      expect(message.contentType).toBe('application/cloudevents+json');
      expect(message['x-cloud-events']?.specversion).toBe('1.0');
      expect(message['x-cloud-events']?.type).toMatch(/^com\.ewoh\./);
      expect(message['x-cloud-events']?.source).toContain('{orgId}');
    }
  });

  it('requires structured object payloads with identifiers and timestamps', () => {
    for (const [type, message] of Object.entries(catalog.components?.messages ?? {})) {
      expect(message.payload?.type).toBe('object');
      expect(Object.keys(message.payload?.properties ?? {}).length).toBeGreaterThan(
        0,
      );
      expect(message.payload?.required ?? []).toEqual(
        expect.arrayContaining(['orgId', 'occurredAt']),
      );
    }
  });
});
