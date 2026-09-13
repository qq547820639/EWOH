/* OrderChainService 契约行为测试（NO-57a 订单链消费面）。
 *
 * 钉住的语义：
 *   1. 订单 → 任务：MES 建单时 `schedule_task_id = 订单号`，快照里 taskIds 为空也要能连上；
 *   2. 任务 → 工序：工序总数/未完成数来自 `ewoh_schedule_task_step`（终态不算未完成）；
 *   3. 物料缺口：需求 − 可用，保留证据订单号；缺料/低于再订货点才出行；
 *   4. 断链显式：无任务/无工序/无物料/无期限 → gaps（不静默省略）；
 *   5. 物料聚合失败 → 如实进 notes 且链路照旧返回（不伪造物料行）；
 *   6. 缺租户上下文 → 400（fail-closed）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import {
  ewohEvent,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';
import { OrderChainService } from '../../../server/modules/world/order-chain.service';

/** 假物料服务：只回快照事实（订单/物料口径复用真实现，测试只关心链路组装）。 */
function materialsStub(facts: {
  orders?: Array<Record<string, unknown>>;
  materials?: Array<Record<string, unknown>>;
  notes?: { ordersNote?: string | null; materialsNote?: string | null };
  error?: Error;
}) {
  return {
    getSnapshotFacts: jest.fn(async () => {
      if (facts.error) throw facts.error;
      return {
        orders: (facts.orders ?? []).map((order) => ({
          orderId: order.orderNo,
          orderNo: order.orderNo,
          status: 'received',
          priority: null,
          dueAt: null,
          taskIds: [],
          ...order,
        })),
        materials: facts.materials ?? [],
        ordersNote: facts.notes?.ordersNote ?? null,
        materialsNote: facts.notes?.materialsNote ?? null,
      };
    }),
  };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'lead.chen', primaryOrgId: ORG, roles: ['workshop_lead'] } as never;

interface Seed {
  orders?: Array<{ eventId: string; status: string; evidenceJson: Record<string, unknown> }>;
  tasks?: Array<{ scheduleTaskId: string; title: string; status: string; source?: string; planStart?: Date | null; planEnd?: Date | null }>;
  steps?: Array<{ scheduleTaskId: string; stepId: string; status: string | null }>;
  materialRows?: Array<Record<string, unknown>>;
  materialError?: Error;
}

function createDb(seed: Seed = {}) {
  const eventRows = (seed.orders ?? []).map((row) => ({ orgId: ORG, ...row }));
  /**
   * 替身必须按**查询投影**的形状返回（不是种子形状）：服务读的是 `taskId`（投影别名），
   * 直接回种子行的 `scheduleTaskId` 会让 `taskId=undefined` → 链路静默连不上
   * （2026-09-12 实测：物料连上了、任务却是空的，排查花了三轮）。
   */
  const taskRows = (seed.tasks ?? []).map((row) => ({
    orgId: ORG,
    taskId: row.scheduleTaskId,
    title: row.title,
    status: row.status,
    source: row.source ?? 'mes',
    planStart: row.planStart ?? null,
    planEnd: row.planEnd ?? null,
  }));
  const stepRows = (seed.steps ?? []).map((row) => ({ orgId: ORG, ...row }));
  const filter = (rows: Array<Record<string, unknown>>) => rows;
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({ limit: async (n: number) => {
            const rows = table === ewohEvent ? eventRows : taskRows;
            return filter(rows).slice(0, n);
          } }),
          limit: async (n: number) => {
            if (table === ewohScheduleTask) return taskRows.slice(0, n);
            if (table === ewohScheduleTaskStep) return stepRows.slice(0, n);
            return [];
          },
        }),
      }),
    }),
    execute: async () => {
      if (seed.materialError) throw seed.materialError;
      return seed.materialRows ?? [];
    },
  };
  return { db };
}

describe('OrderChainService.list（订单 → 任务/工序 → 物料）', () => {
  it('完整链路：任务、工序计数、物料缺口都挂上', async () => {
    // 到期时间用**相对未来**（+7 天）：硬编码日历日期是时间炸弹——
    // 真实时钟一越过该线，"未逾期"翻成"逾期"，用例随日期必然失败（实测于 09-13）。
    const futureDue = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { db } = createDb({
      orders: [
        { eventId: 'EVT-1', status: 'scheduled', evidenceJson: { externalOrderId: 'WO-1001', dueDate: futureDue } },
      ],
      tasks: [{ scheduleTaskId: 'WO-1001', title: '装配工单', status: 'executing' }],
      steps: [
        { scheduleTaskId: 'WO-1001', stepId: 'WO-1001-S1', status: 'completed' },
        { scheduleTaskId: 'WO-1001', stepId: 'WO-1001-S2', status: 'executing' },
      ],
      materialRows: [
        { material_id: 'MAT-1', required: '100', on_hand: '80', min_threshold: null, order_nos: ['WO-1001'] },
      ],
    });
    const service = new OrderChainService(db as never, materialsStub({
      orders: [{ orderNo: 'WO-1001', dueAt: futureDue }],
      materials: [{
        materialId: 'MAT-1', name: null, unit: 'pcs', onHand: 80, requiredTotal: 100,
        shortage: 20, belowThreshold: false, orderNos: ['WO-1001'],
      }],
    }) as never);
    const result = await service.list(ACTOR, {});
    expect(result.chains).toHaveLength(1);
    const [chain] = result.chains;
    expect(chain.tasks[0]).toMatchObject({ taskId: 'WO-1001', stepCount: 2, openStepCount: 1 });
    expect(chain.materials[0]).toMatchObject({ materialId: 'MAT-1', shortage: 20 });
    expect(chain.gaps).toEqual([]);
    expect(result.summary).toMatchObject({ orders: 1, overdue: 0, materialsInShortage: 1, openSteps: 1 });
  });

  it('逾期判定：dueDate 已过 → overdue=true（语义锁，与上例相对日期配对）', async () => {
    const pastDue = new Date(Date.now() - 86_400_000).toISOString();
    const { db } = createDb({
      orders: [
        { eventId: 'EVT-PAST', status: 'scheduled', evidenceJson: { externalOrderId: 'WO-PAST', dueDate: pastDue } },
      ],
      tasks: [{ scheduleTaskId: 'WO-PAST', title: '逾期工单', status: 'executing' }],
      steps: [],
      materialRows: [],
    });
    const service = new OrderChainService(db as never, materialsStub({
      orders: [{ orderNo: 'WO-PAST', dueAt: pastDue }],
      materials: [],
    }) as never);
    const result = await service.list(ACTOR, {});
    expect(result.summary.overdue).toBe(1);
    expect(result.chains[0]?.overdue).toBe(true);
  });

  it('快照 taskIds 为空也能靠"订单号 = 排产任务号"连上（不把已有链路当缺口）', async () => {
    const { db } = createDb({
      orders: [{ eventId: 'EVT-1', status: 'scheduled', evidenceJson: { externalOrderId: 'WO-1001' } }],
      tasks: [{ scheduleTaskId: 'WO-1001', title: '装配', status: 'draft' }],
    });
    const service = new OrderChainService(db as never, materialsStub({
      orders: [{ orderNo: 'WO-1001' }],
    }) as never);
    const [chain] = (await service.list(ACTOR, {})).chains;
    expect(chain.tasks).toHaveLength(1);
    expect(chain.gaps).not.toContain('task_link_missing');
    // 没有工序行 → steps_missing；没有物料 → material_link_missing；没有期限 → due_at_missing
    expect(chain.gaps).toEqual(expect.arrayContaining(['steps_missing', 'material_link_missing', 'due_at_missing']));
  });

  it('物料聚合失败 → notes 如实说明且不伪造物料行', async () => {
    const { db } = createDb({
      orders: [{ eventId: 'EVT-1', status: 'scheduled', evidenceJson: { externalOrderId: 'WO-9' } }],
      tasks: [{ scheduleTaskId: 'WO-9', title: 't', status: 'draft' }],
      materialError: new Error('relation ewoh_erp_outbound does not exist'),
    });
    const service = new OrderChainService(db as never, materialsStub({
      orders: [{ orderNo: 'WO-9' }],
      notes: { materialsNote: '物料事实聚合失败（快照不含物料，不伪造）' },
    }) as never);
    const result = await service.list(ACTOR, {});
    expect(result.chains[0].materials).toEqual([]);
    expect(result.notes.join(' ')).toContain('物料事实聚合失败');
  });

  it('已完工订单不进链路（未完工才是决策面）', async () => {
    const { db } = createDb({});
    const service = new OrderChainService(db as never, materialsStub({
      orders: [{ orderNo: 'WO-DONE', status: 'completed' }, { orderNo: 'WO-OPEN', status: 'scheduled' }],
    }) as never);
    const result = await service.list(ACTOR, {});
    expect(result.chains.map((c) => c.orderNo)).toEqual(['WO-OPEN']);
  });

  it('缺 org 上下文 → 400（fail-closed）', async () => {
    const { db } = createDb({});
    const service = new OrderChainService(db as never, materialsStub({}) as never);
    await expect(service.list(undefined)).rejects.toThrow(BadRequestException);
  });
});
