/* Task 15.2 fault-injection（unit）：PostgreSQL 临时故障——世界态构建路径降级可观测。
 *
 * 覆盖：数据库查询临时失败（注入 db mock 首次抛 typed PG 错误 57P01，随后恢复）时：
 *   - 错误以 typed 形式向上传播（绝不吞掉，调用方/全局异常过滤器可将其转为结构化 5xx）；
 *   - 下一请求自动恢复（临时故障不破坏服务）；
 *   - 断言错误携带原始 pg 错误码（可观测信号），而非被静默降级为无痕成功。
 *
 * 复用 world-state-version.spec.ts 的 fake-db 模式（reservation/binding 表带 where 链）。
 */
/// <reference types="jest" />
import { WorldStateSnapshotService } from '../world-state.service';
import { ewohResourceReservation, ewohDeviceBinding } from '@server/database/schema';
import type { OrgContext } from '../../shared/org-context.interceptor';

/** 模拟一次"连接被终止"的 typed PG 错误（admin_shutdown / server closed the connection）。 */
function pgTerminatedError(): Error & { code: string } {
  return Object.assign(
    new Error('server closed the connection unexpectedly (57P01 admin_shutdown)'),
    { code: '57P01' },
  );
}

interface FakeDb {
  select: jest.Mock;
  insert: jest.Mock;
  execute: jest.Mock;
}

/** 构造 db mock：首次 select().from() 查询以 typed 57P01 拒绝，随后全部恢复成功。 */
function makeDbWithTransientFailure(typedError: Error): FakeDb {
  let fromCalls = 0;
  const select = jest.fn(() => ({
    from: jest.fn((table: unknown) => {
      fromCalls += 1;
      if (fromCalls === 1) return Promise.reject(typedError);
      // reservation/binding 带 where 过滤链；其余表直接返回空数组。
      if (table === ewohResourceReservation || table === ewohDeviceBinding) {
        return { where: () => Promise.resolve([]) };
      }
      return Promise.resolve([]);
    }),
  }));
  const execute = jest.fn().mockResolvedValue([{ last_seq: 1 }]);
  const values = jest.fn().mockResolvedValue(undefined);
  const insert = jest.fn(() => ({ values }));
  return { select, insert, execute };
}

function makeSvc(db: FakeDb) {
  const runInTransaction = jest.fn(
    (_settings: unknown, op: () => Promise<unknown>) => op(),
  );
  const svc = new WorldStateSnapshotService(
    db as never,
    { runInTransaction } as never,
    {
      projectForSnapshot: jest.fn().mockResolvedValue({
        persons: [],
        devices: [],
        stations: [],
      }),
    } as never,
  );
  return { svc, runInTransaction, insertValues: db.insert().values as jest.Mock, execute: db.execute };
}

const ctx: OrgContext = {
  userId: 'u-db-failure-test',
  primaryOrgId: 'org-db-failure-test',
  accessibleOrgIds: ['org-db-failure-test'],
  isGlobalAdmin: false,
};

describe('WorldStateSnapshotService: PostgreSQL 临时故障（Task 15.2 fault-injection）', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('collectState 查询临时抛错（57P01）→ typed 错误向上传播（不吞掉），错误码可观测', async () => {
    const db = makeDbWithTransientFailure(pgTerminatedError());
    const { svc } = makeSvc(db);

    // 15.6：降级必须可观测 —— 错误不被吞掉，而是以 typed 形式传播（含 pg 错误码）。
    let caught: unknown;
    try {
      await svc.buildSnapshot(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/connection/i);
    expect((caught as { code?: string }).code).toBe('57P01');
  });

  it('临时故障后自动恢复：下一次 buildSnapshot 正常成功（故障不持久）', async () => {
    const db = makeDbWithTransientFailure(pgTerminatedError());
    const { svc } = makeSvc(db);

    await expect(svc.buildSnapshot(ctx)).rejects.toMatchObject({ code: '57P01' });
    // 恢复：第二次调用成功（世界态快照正常构建）。
    const snapshot = await svc.buildSnapshot(ctx);
    expect(snapshot.snapshotVersion).toMatch(/^WS-\d{8}-\d{4}$/);
    expect(snapshot.tasks).toEqual([]);
  });
});
