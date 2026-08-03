import { Injectable, Optional } from '@nestjs/common';

export interface IdempotencyRecord<T = unknown> {
  key: string;
  response: T;
  createdAt: Date;
}

export interface IdempotencyStore {
  get<T>(key: string): Promise<IdempotencyRecord<T> | undefined>;
  set<T>(key: string, response: T): Promise<IdempotencyRecord<T>>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord<unknown>>();

  async get<T>(key: string): Promise<IdempotencyRecord<T> | undefined> {
    return this.records.get(key) as IdempotencyRecord<T> | undefined;
  }

  async set<T>(key: string, response: T): Promise<IdempotencyRecord<T>> {
    const record: IdempotencyRecord<T> = { key, response, createdAt: new Date() };
    this.records.set(key, record as IdempotencyRecord<unknown>);
    return record;
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}

@Injectable()
export class IdempotencyService {
  constructor(
    @Optional() private readonly idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore(),
  ) {}

  async lookup<T>(key: string): Promise<T | undefined> {
    const record = await this.idempotencyStore.get<T>(key);
    return record?.response;
  }

  async store<T>(key: string, response: T): Promise<T> {
    const existing = await this.lookup<T>(key);
    if (existing !== undefined) {
      return existing;
    }
    await this.idempotencyStore.set<T>(key, response);
    return response;
  }

  async execute<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const existing = await this.lookup<T>(key);
    if (existing !== undefined) {
      return existing;
    }
    const response = await operation();
    await this.idempotencyStore.set<T>(key, response);
    return response;
  }
}
