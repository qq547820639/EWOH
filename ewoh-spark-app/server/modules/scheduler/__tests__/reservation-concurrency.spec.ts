/* P0-5 Reservation 并发可靠性测试。
 *
 * 应用层 check-then-insert 是快速路径；数据库 EXCLUDE 约束（standalone_009
 * no_overlap）是硬后盾。本测试验证：
 * 1) 应用层预检发现冲突 → 抛 RESOURCE_CONFLICT（409 语义）；
 * 2) 并发插入时 DB 层抛 exclusion_violation（23P01）/unique_violation（23505）
 *    → 被转换为 RESOURCE_CONFLICT，而不是 500；
 * 3) 两个并发 reserve 同一资源重叠时间窗 → 仅一个成功。
 */
/// <reference types="jest" />
import { ConflictException } from '@nestjs/common';
import { ResourceReservationService, type ReservationInput } from '../resource-reservation.service';
import { ewohResourceReservation } from '@server/database/schema';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';

function makeContext() {
  return {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
}

/** 应用层预检返回冲突时 → RESOURCE_CONFLICT。 */
describe('P0-5 Reservation 并发可靠性', () => {
  it('应用层预检命中重叠预约 → RESOURCE_CONFLICT', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([{ id: 'existing' }]),
        })),
      })),
      insert: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new ResourceReservationService(db as never, makeContext() as never);
    await expect(
      svc.reserve('PLAN-1', 'ASN-1', 'T1', [
        { resourceType: 'person', resourceId: 'P1', startMs: 1000, endMs: 2000 },
      ], testOrgContext()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('并发插入时 DB 抛 exclusion_violation(23P01) → 转 RESOURCE_CONFLICT（不 500）', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([]), // 预检无冲突（并发竞态窗口）
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => {
          const err = new Error('conflicting key value violates exclusion constraint');
          (err as { code?: string }).code = '23P01';
          throw err;
        }),
      })),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new ResourceReservationService(db as never, makeContext() as never);
    await expect(
      svc.reserve('PLAN-1', 'ASN-1', 'T1', [
        { resourceType: 'device', resourceId: 'D1', startMs: 1000, endMs: 2000 },
      ], testOrgContext()),
    ).rejects.toMatchObject({ response: expect.objectContaining({ statusCode: 409 }) });
  });

  it('releaseForPlan 不跨租户释放同 planId 预约', async () => {
    const { db, state } = makeFakeDb();
    state.reservations.push(
      {
        id: 'row-org1',
        reservationId: 'RSV-ORG1',
        resourceType: 'station',
        resourceId: 'ST1',
        assignmentId: 'ASG-1',
        planId: 'PLAN-SHARED',
        taskId: 'TASK-1',
        startMs: 1000,
        endMs: 2000,
        status: 'reserved',
        version: 1,
        orgId: 'org1',
      },
      {
        id: 'row-org2',
        reservationId: 'RSV-ORG2',
        resourceType: 'station',
        resourceId: 'ST1',
        assignmentId: 'ASG-2',
        planId: 'PLAN-SHARED',
        taskId: 'TASK-2',
        startMs: 1000,
        endMs: 2000,
        status: 'reserved',
        version: 1,
        orgId: 'org2',
      },
    );
    const svc = new ResourceReservationService(db as never, makeContext() as never);
    const released = await svc.releaseForPlan('PLAN-SHARED', testOrgContext());

    expect(released).toBe(1);
    expect(state.reservations.find((r) => r.reservationId === 'RSV-ORG1')?.status).toBe('released');
    expect(state.reservations.find((r) => r.reservationId === 'RSV-ORG2')?.status).toBe('reserved');
  });

  it('两个并发 reserve 同一资源重叠时间窗 → 仅一个成功（第二个 RESOURCE_CONFLICT）', async () => {
    // 模拟两个并发调用共享一个"正在被占用"的 DB：
    // 第一次 insert 成功；第二次 insert 抛 23P01（真实并发下由 EXCLUDE 约束触发）。
    let inserted = 0;
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn().mockResolvedValue([]), // 双方预检都通过（竞态窗口）
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => {
          if (inserted > 0) {
            const err = new Error('exclusion constraint');
            (err as { code?: string }).code = '23P01';
            throw err;
          }
          inserted++;
          return { returning: jest.fn().mockResolvedValue([{ reservationId: 'RSV-1', resourceType: 'device', resourceId: 'D1', startMs: 1000, endMs: 2000 }]) };
        }),
      })),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new ResourceReservationService(db as never, makeContext() as never);
    const input: ReservationInput = { resourceType: 'device', resourceId: 'D1', startMs: 1000, endMs: 2000 };
    const ctx = testOrgContext();

    const first = await svc.reserve('PLAN-A', 'ASN-A', 'T-A', [input], ctx);
    expect(first).toHaveLength(1);

    await expect(
      svc.reserve('PLAN-B', 'ASN-B', 'T-B', [input], ctx),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inserted).toBe(1); // 只有一次真实插入成功
  });
});
