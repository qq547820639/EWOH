import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, inArray } from 'drizzle-orm';
import { ewohScheduleTask, ewohScheduleTaskStep } from '@server/database/schema';
import { MaterialsService } from '../materials/materials.service';
import {
  buildOrderChains,
  countOpenSteps,
  isOpenOrderStatus as isOpenOrderStatusShared,
  summarizeOrderChains,
  type OrderChainMaterial,
  type OrderChainTask,
  type OrderChainView,
} from '@shared/order-chain';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 订单链服务（NO-57a，§6 世界模型消费面）。
 *
 * 把"订单 → 任务/工序 → 物料"这条链在**同一次读取**里组装出来，并把每处断链显式列成 gap：
 *   · 订单：未完工的 `ERP_ORDER` 事件（与物料快照同一数据源与口径）；
 *   · 任务：`ewoh_schedule_task`（MES 建单时 `schedule_task_id = 订单号`，这条链其实早已存在）；
 *   · 工序：`ewoh_schedule_task_step` → 工序总数 / 未完成数；
 *   · 物料：MRP/领用聚合出的**缺口行**（`ewoh_erp_outbound` 载荷里的 `externalOrderId` 建立订单↔物料关联）。
 *
 * 只读：不写任何业务事实，也不写投影缓存（纯查询面）。
 */
export interface OrderChainResult {
  orgId: string;
  generatedAt: string;
  chains: OrderChainView[];
  summary: ReturnType<typeof summarizeOrderChains>;
  notes: string[];
}

const ERP_ORDER = 'ERP_ORDER';
// 未完工订单判定走共享词表（曾经两处各写一份 → 口径不一致）。
const isOpenOrderStatus = isOpenOrderStatusShared;
const ORDER_SCAN_LIMIT = 200;

@Injectable()
export class OrderChainService {
  private readonly logger = new Logger(OrderChainService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    /**
     * 物料口径**复用 MaterialsService**（同一份 ERP 出站聚合），不再自写一份 SQL：
     * 实测教训：自写的 `ewoh_erp_outbound` 表根本不存在（ERP 出站是事件不是表）→ 接口 500，
     * 而"两处口径"正是这个仓库反复踩的坑。
     */
    private readonly materialsService: MaterialsService,
  ) {}

  async list(
    actor?: OrgContext,
    options: { limit?: number; orderNo?: string } = {},
  ): Promise<OrderChainResult> {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：订单链查询必须带租户上下文');
    }
    const notes: string[] = [];

    // 1) 未完工订单 + 物料缺口：**复用 MaterialsService 的快照事实**（同一口径，
    //    且订单的 taskIds 已由 NO-57a 的投影补全）。
    const facts = await this.materialsService.getSnapshotFacts(actor);
    if (facts.ordersNote) notes.push(facts.ordersNote);
    if (facts.materialsNote) notes.push(facts.materialsNote);
    const openOrders = facts.orders
      .filter((order) => isOpenOrderStatus(order.status))
      .filter((order) => (options.orderNo ? order.orderNo === options.orderNo : true))
      .map((order) => ({
        orderId: order.orderId,
        orderNo: order.orderNo,
        status: order.status,
        priority: order.priority ?? null,
        dueAt: order.dueAt ?? null,
        taskIds: order.taskIds ?? [],
      }));
    const materials: OrderChainMaterial[] = facts.materials.map((material) => ({
      materialId: material.materialId,
      name: material.name ?? null,
      unit: material.unit ?? null,
      requiredTotal: material.requiredTotal,
      onHand: material.onHand,
      shortage: material.shortage,
      belowThreshold: material.belowThreshold,
      orderNos: material.orderNos ?? [],
    }));

    // 2) 任务（订单号 = 排产任务号）
    const orderNos = openOrders.map((order) => order.orderNo);
    const taskRows = orderNos.length === 0
      ? []
      : await this.db
        .select({
          taskId: ewohScheduleTask.scheduleTaskId,
          title: ewohScheduleTask.title,
          status: ewohScheduleTask.status,
          source: ewohScheduleTask.source,
          planStart: ewohScheduleTask.planStart,
          planEnd: ewohScheduleTask.planEnd,
        })
        .from(ewohScheduleTask)
        .where(and(eq(ewohScheduleTask.orgId, orgId), inArray(ewohScheduleTask.scheduleTaskId, orderNos)))
        .limit(500);

    // 3) 工序（计数与工序号）
    const taskIds = taskRows.map((row) => row.taskId);
    const stepRows = taskIds.length === 0
      ? []
      : await this.db
        .select({
          scheduleTaskId: ewohScheduleTaskStep.scheduleTaskId,
          stepId: ewohScheduleTaskStep.stepId,
          status: ewohScheduleTaskStep.status,
        })
        .from(ewohScheduleTaskStep)
        .where(and(eq(ewohScheduleTaskStep.orgId, orgId), inArray(ewohScheduleTaskStep.scheduleTaskId, taskIds)))
        .limit(2000);
    const stepsByTask = new Map<string, Array<{ stepId: string; status: string | null }>>();
    for (const step of stepRows) {
      const taskId = String(step.scheduleTaskId ?? '');
      if (taskId === '') continue;
      const list = stepsByTask.get(taskId) ?? [];
      list.push({ stepId: String(step.stepId ?? ''), status: step.status ?? null });
      stepsByTask.set(taskId, list);
    }
    const tasks: OrderChainTask[] = taskRows.map((row) => {
      const steps = stepsByTask.get(row.taskId) ?? [];
      return {
        taskId: row.taskId,
        title: row.title,
        status: row.status,
        source: row.source,
        planStart: row.planStart ? row.planStart.toISOString() : null,
        planEnd: row.planEnd ? row.planEnd.toISOString() : null,
        stepCount: steps.length,
        openStepCount: countOpenSteps(steps),
        stepIds: steps.map((step) => step.stepId).filter((stepId) => stepId !== ''),
      };
    });

    const chains = buildOrderChains({
      now: new Date().toISOString(),
      orders: openOrders,
      tasks,
      materials,
      limit: options.limit,
    });
    return {
      orgId,
      generatedAt: new Date().toISOString(),
      chains,
      summary: summarizeOrderChains(chains),
      notes,
    };
  }

}
