import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

export interface EventCatalogDocument {
  asyncapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  channels: Record<string, unknown>;
  components?: {
    messages?: Record<string, unknown>;
  };
}

@Injectable()
export class EventCatalogService {
  private readonly catalog: EventCatalogDocument;

  constructor() {
    const candidates = [
      resolve(process.cwd(), 'contracts/events/event-catalog.yaml'),
      resolve(process.cwd(), '../contracts/events/event-catalog.yaml'),
    ];
    if (process.env.EWOH_CONTRACTS_DIR) {
      candidates.unshift(
        resolve(process.env.EWOH_CONTRACTS_DIR, 'events/event-catalog.yaml'),
      );
    }
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) {
      throw new InternalServerErrorException(
        'event catalog contract not found',
      );
    }
    this.catalog = load(readFileSync(file, 'utf8')) as EventCatalogDocument;
  }

  getCatalog(): EventCatalogDocument {
    return this.catalog;
  }

  getEventType(type: string) {
    const message = this.catalog.components?.messages?.[type];
    if (!message) {
      throw new NotFoundException(`Event type ${type} not found`);
    }
    return {
      eventType: type,
      channel: Object.keys(this.catalog.channels).find((channel) => {
        const value = this.catalog.channels[channel] as {
          publish?: { message?: { $ref?: string } };
          subscribe?: { message?: { $ref?: string } };
        };
        const refs = [
          value?.publish?.message?.$ref,
          value?.subscribe?.message?.$ref,
        ];
        return refs.includes(`#/components/messages/${type}`);
      }),
      message,
    };
  }
}
