/**
 * 缺陷 D 回归：幂等 payload 指纹必须落库，且 SharedModule 必须真的 provide
 * IDEMPOTENCY_PAYLOAD_STORE。
 *
 * 修复前的现场后果：SharedModule 只注册了 IDEMPOTENCY_STORE，IdempotencyService
 * 上 `@Optional() @Inject(IDEMPOTENCY_PAYLOAD_STORE)` 静默回落进程内
 * InMemoryPayloadStore。指纹只活在单个进程的 Map 里 →
 *   1) 进程重启 / 第二个实例接手同 key 重放时 `payloadStore.get(key)` 读回
 *      undefined，`recordedFingerprint !== undefined` 的前置判断直接放行：改过
 *      body 的离线重放被当成正常重放，静默拿到旧结果（离线工单/质检重放、
 *      高危危险动作确认都被绕过，而 dangerous-action 注释还自称 durable 指纹）；
 *   2) 于是"同 key 不同 payload 必须 409"在重启/多实例后失效。
 *
 * 本 spec 锁两件事：
 *   · 装配不变量：共享模块提供的 payload store 必须是数据库支撑实现
 *     （useClass 不是 InMemoryPayloadStore）；
 *   · 持久化不变量：指纹写进的是"表"而不是某个对象的内存，因此**另建一个
 *     store/service 实例**（模拟重启/第二个实例）读回同一指纹，不同 payload
 *     仍然 409，且 409 之前不会执行副作用。
 */
import { ConflictException } from '@nestjs/common';
import {
  DbPayloadStore,
  IdempotencyService,
  IDEMPOTENCY_PAYLOAD_STORE,
  InMemoryIdempotencyStore,
  InMemoryPayloadStore,
} from '@server/modules/shared/idempotency.service';
import { SharedModule } from '@server/modules/shared/shared.module';

interface ProviderLike {
  provide?: unknown;
  useClass?: unknown;
  useExisting?: unknown;
  useValue?: unknown;
}

/** 共享模块里 IDEMPOTENCY_PAYLOAD_STORE 的注册项（缺失即缺陷 D 的回归）。 */
function payloadStoreProvider(): ProviderLike | undefined {
  const providers = (Reflect.getMetadata('providers', SharedModule) ?? []) as ProviderLike[];
  return providers.find((provider) => provider.provide === IDEMPOTENCY_PAYLOAD_STORE);
}

/**
 * drizzle sql 查询拆解：SQL 片段 vs 绑定参数。
 *
 * 按实测口径（`new PgDialect().sqlToQuery(sql`...`)` → `$n` 占位 + 独立 params）：
 * SQL 片段是带 `value: string[]` 的 StringChunk；绑定参数是 queryChunks 里的
 * **裸原始值**（`${'default'}` 实测不是对象包装，不能按 chunk 类型区分）。
 * 未识别的 chunk 形态一律抛错——宁可让替身失败，也不要让"条件没生效"伪装成
 * 测试通过（同 drizzle-fake-matcher 的既有教训）。
 */
function splitDrizzleQuery(query: unknown): { text: string; params: unknown[] } {
  const chunks = (query as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) {
    throw new Error('fake fingerprint db: 不是 drizzle sql 查询（缺 queryChunks）');
  }
  const params: unknown[] = [];
  const text = chunks
    .map((chunk) => {
      if (chunk === null || chunk === undefined) return '';
      if (typeof chunk !== 'object') {
        params.push(chunk);
        return '?';
      }
      const candidate = chunk as { value?: unknown; encoder?: unknown; queryChunks?: unknown[] };
      if (Array.isArray(candidate.queryChunks)) {
        throw new Error('fake fingerprint db: 不支持嵌套 SQL 片段');
      }
      if ('encoder' in candidate) {
        params.push(candidate.value);
        return '?';
      }
      if (typeof candidate.value === 'string') return candidate.value;
      if (
        Array.isArray(candidate.value) &&
        candidate.value.every((part) => typeof part === 'string')
      ) {
        return (candidate.value as string[]).join('');
      }
      throw new Error(`fake fingerprint db: 无法识别的 SQL chunk ${JSON.stringify(candidate)}`);
    })
    .join('');
  return { text, params };
}

function makeFingerprintTable(): {
  db: { execute: (query: unknown) => Promise<unknown[]> };
  rows: Map<string, string>;
  statements: string[];
} {
  const rows = new Map<string, string>();
  const statements: string[] = [];

  return {
    rows,
    statements,
    db: {
      async execute(query: unknown): Promise<unknown[]> {
        const { text, params } = splitDrizzleQuery(query);
        statements.push(text.replace(/\s+/g, ' ').trim());
        if (/^\s*SELECT/i.test(text)) {
          if (!/scope = /.test(text) || !/idempotency_key = /.test(text)) {
            throw new Error(`fake fingerprint db: SELECT 缺少键谓词 → ${text}`);
          }
          if (params.length !== 2) {
            throw new Error(`fake fingerprint db: SELECT 参数个数异常 ${params.length}`);
          }
          const fingerprint = rows.get(`${params[0]} ${params[1]}`);
          return fingerprint === undefined ? [] : [{ fingerprint }];
        }
        if (/^\s*INSERT/i.test(text)) {
          if (!/ON CONFLICT \(org_id, scope, idempotency_key\)/i.test(text)) {
            throw new Error(`fake fingerprint db: INSERT 未声明复合冲突目标 → ${text}`);
          }
          if (params.length !== 3) {
            throw new Error(`fake fingerprint db: INSERT 参数个数异常 ${params.length}`);
          }
          rows.set(`${params[0]} ${params[1]}`, String(params[2]));
          return [];
        }
        throw new Error(`fake fingerprint db: 未识别的语句 → ${text}`);
      },
    },
  };
}

const KEY = 'offline-replay-key-1';
const PAYLOAD = { orderId: 'WO-1', stepId: 'S1', action: 'report' };
const TAMPERED = { orderId: 'WO-1', stepId: 'S1', action: 'scrap' };

describe('缺陷 D：幂等 payload 指纹落库（重启/多实例后 409 仍成立）', () => {
  it('SharedModule provide 的 IDEMPOTENCY_PAYLOAD_STORE 是数据库支撑实现，不是进程内 Map', () => {
    const provider = payloadStoreProvider();
    // 修复前这里就是 undefined：@Optional() 注入静默回落 InMemoryPayloadStore。
    expect(provider).toBeDefined();
    const useClass = provider?.useClass ?? provider?.useExisting ?? provider?.useValue;
    expect(useClass).toBe(DbPayloadStore);
    expect(useClass).not.toBe(InMemoryPayloadStore);
  });

  it('DbPayloadStore 把指纹写进表：另建实例（模拟重启）仍能读回同一指纹', async () => {
    const table = makeFingerprintTable();
    const first = new DbPayloadStore(table.db as never);
    await first.set(KEY, 'fingerprint-a');

    // 新实例 = 新进程/第二个实例；共享的只有数据库里的行。
    const restarted = new DbPayloadStore(table.db as never);
    await expect(restarted.get(KEY)).resolves.toBe('fingerprint-a');
    // upsert 覆盖写而不是插入第二行（唯一键 + ON CONFLICT）。
    await restarted.set(KEY, 'fingerprint-b');
    expect(table.rows.size).toBe(1);
    await expect(first.get(KEY)).resolves.toBe('fingerprint-b');
  });

  it('未登记过的 key 读回 undefined（放行首次写入，不误报 409）', async () => {
    const table = makeFingerprintTable();
    const store = new DbPayloadStore(table.db as never);
    await expect(store.get('never-seen-key')).resolves.toBeUndefined();
  });

  it('同 key 不同 payload 在新 service 实例上仍 409，且不执行副作用', async () => {
    const table = makeFingerprintTable();
    // 幂等行本身不在本缺陷范围（DbIdempotencyStore 已落库），这里只隔离指纹的
    // 持久化边界：两个 IdempotencyService 实例各自持有**新建的** DbPayloadStore。
    const idempotencyStore = new InMemoryIdempotencyStore();

    const instanceOne = new IdempotencyService(
      idempotencyStore,
      new DbPayloadStore(table.db as never),
    );
    let sideEffects = 0;
    const recorded = await instanceOne.executeWithPayload(KEY, PAYLOAD, async () => {
      sideEffects += 1;
      return { actionId: 'action-1' };
    });
    expect(recorded).toEqual({ actionId: 'action-1' });

    // 第二个实例（重启/多实例接手重放）：指纹从表里读回，与本次 payload 不符。
    const instanceTwo = new IdempotencyService(
      idempotencyStore,
      new DbPayloadStore(table.db as never),
    );
    const error = await instanceTwo
      .executeWithPayload(KEY, TAMPERED, async () => {
        sideEffects += 1;
        return { actionId: 'action-tampered' };
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).getResponse()).toMatchObject({
      message: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
    });
    // 被拒的重放没有第二次副作用。
    expect(sideEffects).toBe(1);
  });

  it('同 key 同 payload 跨实例仍是幂等重放（不误杀正常重放）', async () => {
    const table = makeFingerprintTable();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const instanceOne = new IdempotencyService(
      idempotencyStore,
      new DbPayloadStore(table.db as never),
    );
    let sideEffects = 0;
    await instanceOne.executeWithPayload(KEY, PAYLOAD, async () => {
      sideEffects += 1;
      return { actionId: 'action-1' };
    });

    const instanceTwo = new IdempotencyService(
      idempotencyStore,
      new DbPayloadStore(table.db as never),
    );
    const replay = await instanceTwo.executeWithPayload(KEY, { ...PAYLOAD }, async () => {
      sideEffects += 1;
      return { actionId: 'action-2' };
    });

    expect(replay).toEqual({ actionId: 'action-1' });
    expect(sideEffects).toBe(1);
  });
});
