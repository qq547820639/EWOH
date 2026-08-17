/**
 * R2-SDB-005：幂等占位式 exactly-once 语义回归。
 *
 * 旧实现为 check-then-act（lookup → operation → set），并发同 key 双调用会
 * 双执行副作用。占位式修复（claim/release/awaitSettled）后：
 *  - 并发双调用副作用仅执行一次，双方拿到同一终值；
 *  - 占位方执行失败释放占位，后续重试可重新执行；
 *  - 未实现 claim 的旧 store 注入回退读-判-写（兼容语义不回归）。
 */
import { IdempotencyService, InMemoryIdempotencyStore } from '../../../server/modules/shared/idempotency.service';

describe('IdempotencyService claim/release (R2-SDB-005)', () => {
  it('并发同 key 双调用仅执行一次副作用且双方结果一致', async () => {
    const store = new InMemoryIdempotencyStore();
    const service = new IdempotencyService(store);
    let executions = 0;
    const operation = async (): Promise<{ seq: number }> => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { seq: executions };
    };
    const [a, b] = await Promise.all([
      service.execute('key-concurrent', operation),
      service.execute('key-concurrent', operation),
    ]);
    expect(executions).toBe(1);
    expect(a).toEqual({ seq: 1 });
    expect(b).toEqual({ seq: 1 });
  });

  it('占位方失败释放占位，重试可重新执行（不悬挂 pending）', async () => {
    const store = new InMemoryIdempotencyStore();
    const service = new IdempotencyService(store);
    let attempts = 0;
    await expect(
      service.execute('key-fail', async () => {
        attempts += 1;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
    // 失败释放后重试成功执行。
    const retried = await service.execute('key-fail', async () => {
      attempts += 1;
      return 'ok';
    });
    expect(attempts).toBe(2);
    expect(retried).toBe('ok');
  });

  it('占位期间重放不拿到 null 假成功（等待终值）', async () => {
    const store = new InMemoryIdempotencyStore();
    const service = new IdempotencyService(store);
    const slow = service.execute('key-slow', async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { value: 42 };
    });
    await new Promise((r) => setTimeout(r, 20));
    const replay = await service.execute('key-slow', async () => ({ value: -1 }));
    expect(await slow).toEqual({ value: 42 });
    expect(replay).toEqual({ value: 42 });
  });

  it('顺序重放不同 payload 仍 409（并发窗口语义不削弱既有指纹防线）', async () => {
    const store = new InMemoryIdempotencyStore();
    const service = new IdempotencyService(store);
    const first = await service.executeWithPayload('key-payload', { a: 1 }, async () => 'r1');
    expect(first).toBe('r1');
    await expect(
      service.executeWithPayload('key-payload', { a: 2 }, async () => 'r2'),
    ).rejects.toThrow('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });

  it('未实现 claim 的旧 store 回退读-判-写（兼容注入不回归）', async () => {
    const legacy = new InMemoryIdempotencyStore() as InMemoryIdempotencyStore & {
      claim?: unknown;
    };
    delete (legacy as { claim?: unknown }).claim;
    const service = new IdempotencyService(legacy);
    const r1 = await service.execute('key-legacy', async () => 'v1');
    const r2 = await service.execute('key-legacy', async () => 'v2');
    expect(r1).toBe('v1');
    expect(r2).toBe('v1');
  });
});
