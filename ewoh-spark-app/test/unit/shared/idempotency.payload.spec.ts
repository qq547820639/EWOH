import { ConflictException } from '@nestjs/common';
import {
  computeFingerprint,
  IdempotencyService,
  InMemoryIdempotencyStore,
  InMemoryPayloadStore,
} from '@server/modules/shared/idempotency.service';

describe('IdempotencyService.executeWithPayload (Task 6 — offline end-to-end idempotency)', () => {
  // TR-6.1: the same idempotency key runs the side effect exactly once.
  it('runs the side effect once for a replayed key with the same payload', async () => {
    const service = new IdempotencyService(
      new InMemoryIdempotencyStore(),
      new InMemoryPayloadStore(),
    );
    let sideEffects = 0;
    const payload = { orderId: 'WO-1', stepId: 'S1', action: 'report' };

    const first = await service.executeWithPayload('idem-key-1', payload, async () => {
      sideEffects += 1;
      return { result: 'ok', n: sideEffects };
    });
    const replay = await service.executeWithPayload('idem-key-1', payload, async () => {
      sideEffects += 1;
      return { result: 'ok', n: sideEffects };
    });

    expect(sideEffects).toBe(1);
    expect(first).toEqual({ result: 'ok', n: 1 });
    expect(replay).toEqual(first);
  });

  // TR-6.2: the same key with a DIFFERENT payload is rejected with 409.
  it('rejects a replayed key carrying a different payload with a ConflictException (409)', async () => {
    const service = new IdempotencyService(
      new InMemoryIdempotencyStore(),
      new InMemoryPayloadStore(),
    );
    let sideEffects = 0;

    await service.executeWithPayload('idem-key-2', { quantity: 1 }, async () => {
      sideEffects += 1;
      return { result: 'ok' };
    });

    await expect(
      service.executeWithPayload('idem-key-2', { quantity: 999 }, async () => {
        sideEffects += 1;
        return { result: 'ok' };
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // The mismatch must be surfaced as a 409 (Nest maps ConflictException so).
    const error = await service
      .executeWithPayload('idem-key-2', { quantity: 999 }, async () => ({ ok: true }))
      .catch((e) => e);
    expect(error instanceof ConflictException).toBe(true);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ message: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' });

    // The rejected replay never ran the side effect.
    expect(sideEffects).toBe(1);
  });

  it('replays the recorded result when the payload is byte-identical', async () => {
    const service = new IdempotencyService(
      new InMemoryIdempotencyStore(),
      new InMemoryPayloadStore(),
    );
    let sideEffects = 0;
    await service.executeWithPayload('idem-key-3', { a: 1, b: { c: 'x' } }, async () => {
      sideEffects += 1;
      return { ok: true };
    });
    // Key order differs but the value is identical → same fingerprint.
    const replay = await service.executeWithPayload(
      'idem-key-3',
      { b: { c: 'x' }, a: 1 },
      async () => {
        sideEffects += 1;
        return { ok: false };
      },
    );
    expect(sideEffects).toBe(1);
    expect(replay).toEqual({ ok: true });
  });

  it('computeFingerprint is deterministic and order-stable', () => {
    expect(computeFingerprint({ b: 2, a: 1 })).toBe(computeFingerprint({ a: 1, b: 2 }));
    expect(computeFingerprint({ a: 1 })).not.toBe(computeFingerprint({ a: 2 }));
    // undefined values normalize to a stable token so absent vs null differ.
    expect(computeFingerprint({ a: undefined })).toBe('{"a":"__undefined__"}');
    expect(computeFingerprint({ a: null })).toBe('{"a":null}');
  });
});