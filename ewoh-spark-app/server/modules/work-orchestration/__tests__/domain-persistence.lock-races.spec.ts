/// <reference types="jest" />
/* DomainPersistenceService 锁与交接写入的可靠性回归：
 * 1) releaseLock 的乐观锁 UPDATE 必须核对命中行数——version 被并发推进时
 *    命中 0 行，原实现仍返回 released=true（把"没写成"伪造成"已释放"）；
 * 2) acquireLock 的并发插入撞 (org_id, resource_key) 唯一键（23505）必须
 *    转 409 ConflictException，而非把驱动原始错误当 500；
 * 3) 交接状态转移的 WHERE 必须带调用方校验时所依据的前置状态（TOCTOU 守卫），
 *    两个互斥转移（open→accepted / open→rejected）不再静默先后落库。
 * 用 stub db 模拟 drizzle 链式调用，并用 PgDialect 序列化捕获到的 WHERE
 * 谓词做断言（不需要真实数据库连接）。 */
import { ConflictException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DomainPersistenceService } from '../domain-persistence.service';

type ThenableRows = { then: (resolve: (rows: unknown[]) => unknown) => unknown };

interface CapturedUpdate {
  where?: SQL;
  returningCalled: boolean;
}

/** 最小 drizzle 形状 stub：记录 update 的 where 谓词与 returning 调用。 */
function makeStubDb(options: {
  selectRows: unknown[];
  updateRows: unknown[];
  insertShouldThrow?: { code: string };
}) {
  const dialect = new PgDialect();
  const captured: { updateWhere?: SQL; returningCalled: boolean } = {
    returningCalled: false,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(options.selectRows) as unknown as ThenableRows,
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
        returning: () => {
          if (options.insertShouldThrow) {
            return Promise.reject(options.insertShouldThrow);
          }
          return Promise.resolve([{ id: 1 }]);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (cond: SQL) => {
          captured.updateWhere = cond;
          return {
            returning: () => {
              captured.returningCalled = true;
              return Promise.resolve(options.updateRows);
            },
          };
        },
      }),
    }),
    execute: () => Promise.resolve([]),
  };
  return { db, captured, dialect };
}

function makeService(stubDb: ReturnType<typeof makeStubDb>['db']) {
  const requestContext = {
    systemTransaction: async (op: (db: unknown) => Promise<unknown>) =>
      op(stubDb),
  };
  return new DomainPersistenceService(requestContext as never);
}

describe('DomainPersistenceService：锁写入可靠性（乐观锁/唯一键竞争）', () => {
  const INPUT = {
    orgId: 'org-1',
    resourceKey: 'res-1',
    holder: 'u1',
  };

  it('releaseLock：乐观锁 UPDATE 命中 0 行 → 409，不再伪造 released=true', async () => {
    const stub = makeStubDb({
      selectRows: [{ id: 7, active: true, holder: 'u1', version: 3 }],
      updateRows: [], // 并发 renew 已把 version 推进 → 0 行命中
    });
    const service = makeService(stub.db);
    await expect(service.releaseLock(INPUT)).rejects.toThrow(ConflictException);
    expect(stub.captured.returningCalled).toBe(true);
  });

  it('releaseLock：命中 1 行 → released=true', async () => {
    const stub = makeStubDb({
      selectRows: [{ id: 7, active: true, holder: 'u1', version: 3 }],
      updateRows: [{ id: 7 }],
    });
    const service = makeService(stub.db);
    await expect(service.releaseLock(INPUT)).resolves.toEqual({
      released: true,
      holder: 'u1',
    });
  });

  it('acquireLock：并发插入撞唯一键（23505）→ 409，而非裸 500', async () => {
    const stub = makeStubDb({
      selectRows: [], // 无既有行 → 走插入分支
      updateRows: [],
      insertShouldThrow: { code: '23505' },
    });
    const service = makeService(stub.db);
    await expect(
      service.acquireLock({ ...INPUT, resourceId: 'res-1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('acquireLock：其余插入错误原样重抛（不吞）', async () => {
    const stub = makeStubDb({
      selectRows: [],
      updateRows: [],
      insertShouldThrow: { code: '08000' },
    });
    const service = makeService(stub.db);
    await expect(
      service.acquireLock({ ...INPUT, resourceId: 'res-1' }),
    ).rejects.toMatchObject({ code: '08000' });
  });
});

describe('DomainPersistenceService：交接状态转移 TOCTOU 守卫', () => {
  it('updateHandoffStatus：WHERE 携带调用方校验的前置状态', async () => {
    const stub = makeStubDb({
      selectRows: [],
      updateRows: [{ handoffId: 'HO-1', state: 'closed' }],
    });
    const service = makeService(stub.db);
    await service.updateHandoffStatus('HO-1', 'closed', 'accepted');
    const serialized = stub.dialect.sqlToQuery(stub.captured.updateWhere as SQL);
    // WHERE = (handoff_id = 'HO-1' AND state = 'accepted')——'accepted' 是
    // 调用方校验时的前置状态，新状态 'closed' 只出现在 SET 中。
    expect(serialized.sql).toContain('"state" =');
    expect(serialized.params).toContain('HO-1');
    expect(serialized.params).toContain('accepted');
    expect(serialized.params).not.toContain('closed');
  });

  it('acceptHandoffWithTaskUpdate：固定以前置状态 open 为谓词', async () => {
    const stub = makeStubDb({
      selectRows: [],
      updateRows: [{ handoffId: 'HO-1', state: 'accepted' }],
    });
    const service = makeService(stub.db);
    await service.acceptHandoffWithTaskUpdate('HO-1');
    const serialized = stub.dialect.sqlToQuery(stub.captured.updateWhere as SQL);
    expect(serialized.params).toContain('HO-1');
    expect(serialized.params).toContain('open');
    expect(serialized.params).not.toContain('accepted');
  });
});
