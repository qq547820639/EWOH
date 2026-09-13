/// <reference types="jest" />
/* NEST-226 语义回归：registerEfficiencyEntry 未传 completedAt 时必须落
 * null（=完成时间未知），不得回退 now()——回退会把"未知完成时刻"伪造成
 * "录入那一刻完成"，efficiency 数据的时间语义整体失真。 */
import { OperationsService } from './operations.service';

function makeDb() {
  return {
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => [
            {
              configKey: value.configKey as string,
              configValue: value.configValue,
              updatedBy: value.updatedBy,
              updatedAt: new Date(),
            },
          ],
        }),
      }),
    }),
  };
}

function makeAudit() {
  return { appendAuditLog: async () => undefined };
}

describe('OperationsService.registerEfficiencyEntry：completedAt 不伪造（NEST-226）', () => {
  const ACTOR = { userId: 'u1', primaryOrgId: 'org-1' } as never;

  it('未传 completedAt → 落 null（完成时间未知），而非当前时间', async () => {
    const service = new OperationsService(makeDb() as never, makeAudit() as never);
    const entry = await service.registerEfficiencyEntry(
      {
        workerId: 'w-1',
        workCenterId: 'WC-1',
        operationCode: 'OP-10',
        actualMinutes: 12,
        standardMinutes: 10,
      },
      ACTOR,
    );
    expect(entry.completedAt).toBeNull();
  });

  it('显式传入 completedAt → 原样保留', async () => {
    const service = new OperationsService(makeDb() as never, makeAudit() as never);
    const entry = await service.registerEfficiencyEntry(
      {
        workerId: 'w-1',
        workCenterId: 'WC-1',
        operationCode: 'OP-10',
        actualMinutes: 12,
        standardMinutes: 10,
        completedAt: '2026-09-01T08:00:00.000Z',
      },
      ACTOR,
    );
    expect(entry.completedAt).toBe('2026-09-01T08:00:00.000Z');
  });
});
