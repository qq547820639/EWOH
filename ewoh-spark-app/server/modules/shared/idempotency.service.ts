import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
export const IDEMPOTENCY_PAYLOAD_STORE = Symbol('IDEMPOTENCY_PAYLOAD_STORE');

export interface IdempotencyRecord<T = unknown> {
  key: string;
  response: T;
  createdAt: Date;
}

export interface IdempotencyStore {
  /** NEST-518（2026-08-17）：可选 scope 维度——不同业务域的同名 key 不再碰撞；
   * 不传 scope 时各实现回退自身默认（内存实现用复合键，DB 实现用 scope 列）。 */
  get<T>(key: string, scope?: string): Promise<IdempotencyRecord<T> | undefined>;
  set<T>(key: string, response: T, scope?: string): Promise<IdempotencyRecord<T>>;
  /**
   * R2-SDB-005：原子占位——先 INSERT pending 占位行（response 为空），
   * 冲突（同 key 已存在）返回 false。占位式 exactly-once：抢到占位的调用方
   * 才执行副作用，并发方轮询读回终值，消除 check-then-act 双执行窗口。
   */
  claim?(key: string, scope?: string): Promise<boolean>;
  /** R2-SDB-005：执行失败时释放 pending 占位（仅清 response 为空的行），允许重试。 */
  release?(key: string, scope?: string): Promise<void>;
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

  async get<T>(key: string, scope = 'default'): Promise<IdempotencyRecord<T> | undefined> {
    return this.records.get(`${scope}:${key}`) as IdempotencyRecord<T> | undefined;
  }

  async set<T>(key: string, response: T, scope = 'default'): Promise<IdempotencyRecord<T>> {
    const record: IdempotencyRecord<T> = { key, response, createdAt: new Date() };
    this.records.set(`${scope}:${key}`, record as IdempotencyRecord<unknown>);
    return record;
  }

  /** R2-SDB-005：Map 原子 set-if-absent 占位（含 pending 占位行）。 */
  async claim(key: string, scope = 'default'): Promise<boolean> {
    const composite = `${scope}:${key}`;
    if (this.records.has(composite)) return false;
    this.records.set(composite, { key, response: undefined, createdAt: new Date() } as IdempotencyRecord<unknown>);
    return true;
  }

  /** R2-SDB-005：仅释放 pending 占位（终值已写入的行不动）。 */
  async release(key: string, scope = 'default'): Promise<void> {
    const composite = `${scope}:${key}`;
    const record = this.records.get(composite);
    if (record && record.response === undefined) {
      this.records.delete(composite);
    }
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
    // R2-SDB-005：pending 占位行 response 为 null/undefined——统一视为未决，
    // 不得当作已完成结果返回（否则占位期间重放会拿到 null 假成功）。
    return record?.response ?? undefined;
  }

  async store<T>(key: string, response: T): Promise<T> {
    const existing = await this.lookup<T>(key);
    if (existing !== undefined) {
      return existing;
    }
    await this.idempotencyStore.set<T>(key, response);
    return response;
  }

  /**
   * R2-SDB-005：并发方等待占位方写回终值（轮询至超时）。
   * 超时抛 409 IDEMPOTENCY_KEY_INFLIGHT（不静默重执行，不伪造成功）。
   */
  private async awaitSettled<T>(key: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const existing = await this.lookup<T>(key);
      if (existing !== undefined) {
        return existing;
      }
      if (Date.now() >= deadline) {
        throw new ConflictException({
          message: 'IDEMPOTENCY_KEY_INFLIGHT',
          idempotencyKey: key,
          detail: '并发请求正在执行同 key 操作，请稍后重试（不重复执行副作用）',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async execute<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const existing = await this.lookup<T>(key);
    if (existing !== undefined) {
      return existing;
    }
    // R2-SDB-005：占位式 exactly-once——原子占位成功方执行副作用并回写终值；
    // 并发方等待读回终值。消除旧 check-then-act 双执行竞态。
    const store = this.idempotencyStore;
    if (typeof store.claim === 'function') {
      const won = await store.claim(key);
      if (!won) {
        return this.awaitSettled<T>(key);
      }
      try {
        const response = await operation();
        await this.idempotencyStore.set<T>(key, response);
        return response;
      } catch (err) {
        await store.release?.(key);
        throw err;
      }
    }
    // 兼容未实现 claim 的旧 store 注入：保持读-判-写（弱保证），注释声明降级语义。
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
    // R2-SDB-005：占位式 exactly-once（同 execute）；并发不同 payload 的极端
    // 窗口（占位方尚未写指纹）读回占位方终值而非 409——指纹 409 对顺序重放
    // （离线重放主威胁）仍然成立，注释声明该并发窗口语义。
    const store = this.idempotencyStore;
    if (typeof store.claim === 'function') {
      const won = await store.claim(key);
      if (!won) {
        const settled = await this.awaitSettled<T>(key);
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
        return settled;
      }
      try {
        const response = await operation();
        await this.idempotencyStore.set<T>(key, response);
        await this.payloadStore.set(key, fingerprint);
        return response;
      } catch (err) {
        await store.release?.(key);
        throw err;
      }
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
 * values are normalized to a stable token so small JSON shape differences do
 * not spuriously collide.
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
