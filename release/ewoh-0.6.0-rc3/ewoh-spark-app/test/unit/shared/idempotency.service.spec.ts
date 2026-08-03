import {
  IdempotencyService,
  InMemoryIdempotencyStore,
} from '../../../server/modules/shared/idempotency.service';

describe('IdempotencyService', () => {
  it('returns the original response for duplicate keys', async () => {
    const service = new IdempotencyService(new InMemoryIdempotencyStore());
    const original = { id: 'req-1', ok: true };

    await expect(service.store('idem-1', original)).resolves.toBe(original);
    const duplicate = await service.store('idem-1', { id: 'other', ok: false });
    expect(duplicate).toBe(original);
  });

  it('runs the operation once and replays the stored response', async () => {
    const service = new IdempotencyService(new InMemoryIdempotencyStore());
    let calls = 0;

    const first = await service.execute('idem-2', async () => {
      calls += 1;
      return { n: 1 };
    });
    const second = await service.execute('idem-2', async () => {
      calls += 1;
      return { n: 2 };
    });

    expect(calls).toBe(1);
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
    expect(await service.lookup('idem-2')).toEqual({ n: 1 });
  });
});
