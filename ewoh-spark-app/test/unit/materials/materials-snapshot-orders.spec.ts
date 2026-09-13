/* 世界快照的**订单 → 任务/工序**投影回归（NO-57a）。
 *
 * 缺陷背景：`WorldSnapshotOrder.taskIds` 与 `remainingOperations` 长期被写死
 * （`[]` / `null`），而 MES 建单时 `schedule_task_id = 订单号`、工序行就在
 * `ewoh_schedule_task_step` 里——链路一直存在，只是投影从没读它。
 * 后果：所有消费方都以为"订单没有任务"，把已有事实当成缺口。
 */
/// <reference types="jest" />
import { ewohEvent, ewohScheduleTask, ewohScheduleTaskStep } from '@server/database/schema';
import { MaterialsService } from '../../../server/modules/materials/materials.service';

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const ACTOR = { userId: 'dispatcher.wang', primaryOrgId: ORG, roles: ['dispatcher'] } as never;

function createDb(seed: {
  orders: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
}) {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              return table === ewohEvent ? seed.orders.slice(0, n) : [];
            },
          }),
          limit: async (n: number) => {
            if (table === ewohScheduleTask) return (seed.tasks ?? []).slice(0, n);
            if (table === ewohScheduleTaskStep) return (seed.steps ?? []).slice(0, n);
            return [];
          },
        }),
      }),
    }),
    execute: async () => [],
  };
  return db;
}

describe('MaterialsService.getSnapshotFacts（订单链路投影）', () => {
  it('订单 → 任务号 + 未完成工序数真的填上（不再写死空数组/null）', async () => {
    const db = createDb({
      orders: [{
        orgId: ORG,
        eventId: 'EVT-1',
        // ERP_ORDER 的"未完工"词表是 received/draft/pending/scheduled/dispatched/executing，
        // 没有 'open'（共享词表 OPEN_ORDER_STATUSES 是唯一口径）。
        status: 'received',
        evidenceJson: { externalOrderId: 'WO-1001', dueDate: '2026-09-13T08:00:00.000Z' },
      }],
      tasks: [{ orgId: ORG, taskId: 'WO-1001', title: '装配工单', status: 'executing' }],
      steps: [
        { orgId: ORG, scheduleTaskId: 'WO-1001', stepId: 'S1', status: 'completed' },
        { orgId: ORG, scheduleTaskId: 'WO-1001', stepId: 'S2', status: 'executing' },
        { orgId: ORG, scheduleTaskId: 'WO-1001', stepId: 'S3', status: 'cancelled' },
      ],
    });
    const service = new MaterialsService(db as never);
    jest.spyOn(service, 'getInventory').mockResolvedValue({
      impact: [],
      aggregationComplete: true,
      ordersTruncated: false,
    } as never);

    const facts = await service.getSnapshotFacts(ACTOR);

    expect(facts.orders).toHaveLength(1);
    expect(facts.orders[0]).toMatchObject({ orderNo: 'WO-1001', taskIds: ['WO-1001'], remainingOperations: 1 });
  });

  it('订单没有对应任务时保持**显式缺口**（空数组/null），不编造任务号', async () => {
    const db = createDb({
      orders: [{ orgId: ORG, eventId: 'EVT-2', status: 'executing', evidenceJson: { externalOrderId: 'WO-NOLINK' } }],
      tasks: [{ orgId: ORG, taskId: 'WO-OTHER', title: 'x', status: 'draft' }],
    });
    const service = new MaterialsService(db as never);
    jest.spyOn(service, 'getInventory').mockResolvedValue({
      impact: [],
      aggregationComplete: true,
      ordersTruncated: false,
    } as never);

    const facts = await service.getSnapshotFacts(ACTOR);
    expect(facts.orders[0].taskIds).toEqual([]);
    expect(facts.orders[0].remainingOperations).toBeNull();
  });

  it('已完工订单不进快照（快照是决策面）', async () => {
    const db = createDb({
      orders: [
        { orgId: ORG, eventId: 'EVT-3', status: 'completed', evidenceJson: { externalOrderId: 'WO-DONE' } },
        { orgId: ORG, eventId: 'EVT-4', status: 'scheduled', evidenceJson: { externalOrderId: 'WO-OPEN' } },
      ],
    });
    const service = new MaterialsService(db as never);
    jest.spyOn(service, 'getInventory').mockResolvedValue({
      impact: [],
      aggregationComplete: true,
      ordersTruncated: false,
    } as never);

    const facts = await service.getSnapshotFacts(ACTOR);
    expect(facts.orders.map((order) => order.orderNo)).toEqual(['WO-OPEN']);
  });
});
