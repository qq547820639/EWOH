/* P0-7：station capacity 感知的 reservation。
 *
 * 背景：DB EXCLUDE 约束（standalone_009）是二值占用——容量>1 工位求解器可排
 * 两个重叠任务（AddCumulative），但 dispatch 第二个重叠预占会被 EXCLUDE 拒绝
 * → RESOURCE_CONFLICT。修复：应用层计数（count < capacity）+ advisory lock。
 *
 * 验证：
 *   1. capacity=1 工位第二个重叠任务被拒（与旧二值语义一致）；
 *   2. capacity=2 工位两个重叠任务都成功预占；
 *   3. capacity=2 工位第三个重叠任务被拒（count >= capacity）；
 *   4. person/device 仍为二值占用（重叠即冲突）。
 */
/// <reference types="jest" />
import { ConflictException } from '@nestjs/common';
import {
  ResourceReservationService,
  type ReservationInput,
} from '../resource-reservation.service';
import { testOrgContext } from './dispatch-test-harness';

/** 可编程 fake DB：where 按调用序列返回可控的"重叠行数"（count 计数逻辑核心）。
 * 时间窗 SQL 过滤（lt/gt）由 drizzle 负责（与旧实现相同的谓词），单测聚焦
 * count < capacity 判定；insert 记录已插入行供计数场景复用。
 */
function makeDb(overlapResults: Array<unknown[]>) {
  let call = 0;
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => {
          const result = overlapResults[Math.min(call, overlapResults.length - 1)] ?? [];
          call += 1;
          return Promise.resolve(result.map((r) => ({ ...(r as object) })));
        }),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((v: unknown) => {
        inserted.push({ ...(v as Record<string, unknown>) });
        return {
          returning: jest.fn().mockResolvedValue([
            {
              reservationId: (v as { reservationId?: string }).reservationId ?? 'RSV',
              resourceType: (v as { resourceType?: string }).resourceType ?? '',
              resourceId: (v as { resourceId?: string }).resourceId ?? '',
              startMs: (v as { startMs?: number }).startMs ?? 0,
              endMs: (v as { endMs?: number }).endMs ?? 0,
            },
          ]),
        };
      }),
    })),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  return { db, inserted };
}

function makeContext() {
  return {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
}

function svcWith(db: unknown) {
  return new ResourceReservationService(db as never, makeContext() as never);
}

describe('P0-7: station capacity 感知 reservation', () => {
  it('capacity=1 工位：第二个重叠任务被拒（RESOURCE_CONFLICT）', async () => {
    // 第一次查询 0 重叠 → 放行插入；第二次查询 1 重叠 → 1>=1 拒绝。
    const { db } = makeDb([[], [{ id: 'existing' }]]);
    const svc = svcWith(db);
    const input: ReservationInput = {
      resourceType: 'station',
      resourceId: 'S1',
      startMs: 1000,
      endMs: 2000,
      capacity: 1,
    };
    const ctx = testOrgContext();
    await expect(svc.reserve('PLAN-A', 'ASN-A', 'T-A', [input], ctx)).resolves.toHaveLength(1);
    await expect(svc.reserve('PLAN-B', 'ASN-B', 'T-B', [input], ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('capacity=2 工位：两个重叠任务都成功预占（count 1 < 2）', async () => {
    // 第一次 0 重叠；第二次 1 重叠（1<2 放行）。
    const { db } = makeDb([[], [{ id: 'existing' }]]);
    const svc = svcWith(db);
    const input: ReservationInput = {
      resourceType: 'station',
      resourceId: 'S1',
      startMs: 1000,
      endMs: 2000,
      capacity: 2,
    };
    const ctx = testOrgContext();
    const first = await svc.reserve('PLAN-A', 'ASN-A', 'T-A', [input], ctx);
    expect(first).toHaveLength(1);
    const second = await svc.reserve('PLAN-B', 'ASN-B', 'T-B', [input], ctx);
    expect(second).toHaveLength(1);
  });

  it('capacity=2 工位：第三个重叠任务被拒（count 2 >= 2）', async () => {
    const { db } = makeDb([[], [{ id: 'r1' }], [{ id: 'r1' }, { id: 'r2' }]]);
    const svc = svcWith(db);
    const input: ReservationInput = {
      resourceType: 'station',
      resourceId: 'S1',
      startMs: 1000,
      endMs: 2000,
      capacity: 2,
    };
    const ctx = testOrgContext();
    await svc.reserve('PLAN-A', 'ASN-A', 'T-A', [input], ctx);
    await svc.reserve('PLAN-B', 'ASN-B', 'T-B', [input], ctx);
    await expect(svc.reserve('PLAN-C', 'ASN-C', 'T-C', [input], ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('person/device 仍为二值占用（重叠即冲突，capacity 字段忽略）', async () => {
    const { db } = makeDb([[], [{ id: 'existing' }]]);
    const svc = svcWith(db);
    const input: ReservationInput = {
      resourceType: 'person',
      resourceId: 'P1',
      startMs: 1000,
      endMs: 2000,
      capacity: 99, // 即使传大容量，person 仍二值。
    };
    const ctx = testOrgContext();
    await svc.reserve('PLAN-A', 'ASN-A', 'T-A', [input], ctx);
    await expect(svc.reserve('PLAN-B', 'ASN-B', 'T-B', [input], ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('assertStationCapacityAvailable：capacity=1 工位已有占用 → STATION_CAPACITY', async () => {
    const { db } = makeDb([[{ id: 'existing' }]]);
    const svc = svcWith(db);
    await expect(
      svc.assertStationCapacityAvailable(
        [{ resourceType: 'station', resourceId: 'S1', startMs: 1500, endMs: 2500, capacity: 1 }],
        testOrgContext(),
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ statusCode: 409 }) });
  });

  it('advisory lock 调用：station 预占先取 pg_advisory_xact_lock（并发串行化）', async () => {
    const { db } = makeDb([[]]);
    const svc = svcWith(db);
    await svc.reserve('PLAN-A', 'ASN-A', 'T-A', [
      { resourceType: 'station', resourceId: 'S1', startMs: 1000, endMs: 2000, capacity: 2 },
    ], testOrgContext());
    expect(db.execute).toHaveBeenCalled();
  });
});
