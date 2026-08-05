import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
export const IDEMPOTENCY_PAYLOAD_STORE = Symbol('IDEMPOTENCY_PAYLOAD_STORE');

export interface IdempotencyRecord<T = unknown> {
  key: string;
  response: T;
  createdAt: Date;
}

export interface IdempotencyStore {
  get<T>(key: string): Promise<IdempotencyRecord<T> | undefined>;
  set<T>(key: string, response: T): Promise<IdempotencyRecord<T>>;
}

/**
 * Durable-by-choice fingerprint store that records the request payload that was
 * associated with a given idempotency key. Used to reject a replay of the same
 * key with a DIFFERENT payload (HTTP 409) — the offline client must never be
 * able to silently re-target an earlier result with a mutated body.
 */
export interface PayloadStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, fingerprint: string): Promise<void>;
}

export class InMemoryPayloadStore implements PayloadStore {
  private readonly fingerprints = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.fingerprints.get(key);
  }

  async set(key: string, fingerprint: string): Promise<void> {
    this.fingerprints.set(key, fingerprint);
  }

  clear(): void {
    this.fingerprints.clear();
  }

  get size(): number {
    return this.fingerprints.size;
  }
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
    @Optional() @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore(),
    @Optional() @Inject(IDEMPOTENCY_PAYLOAD_STORE)
    private readonly payloadStore: PayloadStore = new InMemoryPayloadStore(),
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

  /**
   * Idempotent execution that also binds the request payload to the key. A
   * replay with the SAME key and a DIFFERENT payload is rejected with a 409
   * (ConflictException) instead of silently returning the earlier result, so a
   * mutated offline body can never ride on a previously recorded outcome. The
   * side effect (`operation`) runs exactly once per key.
   */
  async executeWithPayload<T>(
    key: string,
    payload: unknown,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const fingerprint = computeFingerprint(payload ?? {});
    const existing = await this.lookup<T>(key);
    if (existing !== undefined) {
      const recordedFingerprint = await this.payloadStore.get(key);
      if (
        recordedFingerprint !== undefined &&
        recordedFingerprint !== fingerprint
      ) {
        throw new ConflictException({
          message: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
          idempotencyKey: key,
          detail:
            'The idempotency key was already used with a different payload and cannot be reused.',
        });
      }
      return existing;
    }
    const response = await operation();
    await this.idempotencyStore.set<T>(key, response);
    await this.payloadStore.set(key, fingerprint);
    return response;
  }
}

/**
 * Deterministic, key-order-stable fingerprint of an arbitrary payload. Used to
 * detect payload changes for a replayed idempotency key. `undefined`/`null`
 * values are normalized to a stable token so small JSON shape differences do not
 * spuriously collide.
 */
export function computeFingerprint(payload: unknown): string {
  return JSON.stringify(stableClone(payload));
}

function stableClone(value: unknown): unknown {
  if (value === undefined) return '__undefined__';
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => stableClone(item));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = stableClone(record[key]);
    }
    return out;
  }
  return value;
}
