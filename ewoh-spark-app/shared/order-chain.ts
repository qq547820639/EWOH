/* 前后端共享契约 —— 订单链（订单 → 任务/工序 → 物料）链路视图（NO-57a，§6 世界模型消费面）。
 *
 * 补的缺口：世界快照早已有订单与物料行（DR-6），但**订单→任务→物料的链路**没有消费面：
 *   · `WorldSnapshotOrder.taskIds` 一直是空数组（投影里写死 `[]`），
 *     而 MES 建单时 `schedule_task_id = <orderId>`（订单号就是排产任务号）——
 *     **链路其实存在，只是没人用**；
 *   · `remainingOperations` 也是写死 null，而 `ewoh_schedule_task_step` 里有工序行。
 * 本契约把链路算清楚，并把**每一处断链显式列成 gap**（原则 7：缺口不许静默省略）。
 */

export interface OrderChainTask {
  taskId: string;
  title: string;
  status: string;
  source: string;
  planStart: string | null;
  planEnd: string | null;
  /** 工序总数（来自 `ewoh_schedule_task_step`；无工序行 → 0）。 */
  stepCount: number;
  /** 未完成工序数（status 不在终态集合内）。 */
  openStepCount: number;
  /** 该订单物料需求里引用到的工序号（可追"哪道工序要这个料"）。 */
  stepIds: string[];
}

export interface OrderChainMaterial {
  materialId: string;
  name: string | null;
  unit: string | null;
  requiredTotal: number;
  onHand: number;
  shortage: number;
  belowThreshold: boolean;
  /** 该物料的证据（出站单/事件号）。 */
  orderNos: string[];
}

export interface OrderChainView {
  orderNo: string;
  status: string;
  priority: string | null;
  dueAt: string | null;
  /** 是否已逾期（有 dueAt 且早于 now）；无期限 → null（不猜）。 */
  overdue: boolean | null;
  tasks: OrderChainTask[];
  materials: OrderChainMaterial[];
  /** 链路缺口（封闭词表）：链路不完整时必须显式给出。 */
  gaps: string[];
  /** 责任/执行面提示：任务已指派到人/设备的数量。 */
  assignedTaskCount: number;
  notes: string[];
}

/**
 * 未完工订单状态词表（**唯一口径**）。
 *
 * 来源：`ERP_ORDER` 事件的 status 取值（MES/ERP 出站写入）。
 * 为什么必须共享：订单链消费面（`OrderChainService`）与物料快照投影（`MaterialsService`）
 * 如果各写一份，就会出现"链路说这单还没完工、物料说这单不存在"的两套口径
 * （2026-09-12 实测：链路服务里我写了 `'open'`，而物料侧根本没有这个值）。
 */
export const OPEN_ORDER_STATUSES = [
  'received',
  'draft',
  'pending',
  'scheduled',
  'dispatched',
  'executing',
] as const;

const OPEN_ORDER_STATUS_SET: ReadonlySet<string> = new Set(OPEN_ORDER_STATUSES);

/** 该状态是否算"未完工订单"（大小写不敏感；未知状态 → false，不猜）。 */
export function isOpenOrderStatus(status: string | null | undefined): boolean {
  return OPEN_ORDER_STATUS_SET.has(String(status ?? '').trim().toLowerCase());
}

export const ORDER_CHAIN_GAPS = [
  /** 订单没有任何排产任务（`schedule_task_id = 订单号` 查不到）。 */
  'task_link_missing',
  /** 订单任务没有任何工序行（无法判断还有几道工序）。 */
  'steps_missing',
  /** 订单没有任何物料需求（BOM/领用证据缺失）。 */
  'material_link_missing',
  /** 订单缺交付期限（无法判断是否逾期）。 */
  'due_at_missing',
] as const;

export interface BuildOrderChainsInput {
  now: string;
  orders: Array<{
    orderId: string;
    orderNo: string;
    status: string;
    priority?: string | null;
    dueAt?: string | null;
    taskIds?: string[];
  }>;
  tasks: OrderChainTask[];
  materials: OrderChainMaterial[];
  /** 单次最多返回多少条（按逾期 → 期限 → 订单号 排序，默认 20）。 */
  limit?: number;
}

/** 任务状态终态（与 task 域一致）：用于"未完成工序数"口径。 */
const TERMINAL_STEP_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'skipped']);
export const ORDER_CHAIN_DEFAULT_LIMIT = 20;

/**
 * 组装订单链（纯函数）。
 *
 * 排序：**逾期优先 → 有期限的在前（按期限升序）→ 订单号稳定排序**，
 * 让班组长/调度员先看到"已经晚了"和"快到了"的单子。
 */
export function buildOrderChains(input: BuildOrderChainsInput): OrderChainView[] {
  const nowMs = Date.parse(input.now);
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.trunc(Number(input.limit))) : ORDER_CHAIN_DEFAULT_LIMIT;
  const materialsByOrder = new Map<string, OrderChainMaterial[]>();
  for (const material of input.materials ?? []) {
    for (const orderNo of material.orderNos ?? []) {
      const list = materialsByOrder.get(orderNo) ?? [];
      list.push(material);
      materialsByOrder.set(orderNo, list);
    }
  }
  const tasksById = new Map((input.tasks ?? []).map((task) => [task.taskId, task]));

  const views: OrderChainView[] = (input.orders ?? []).map((order) => {
    const linkedTaskIds = [
      ...new Set([...(order.taskIds ?? []), ...(tasksById.has(order.orderNo) ? [order.orderNo] : [])]),
    ].filter((taskId) => taskId.trim() !== '');
    const tasks = linkedTaskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is OrderChainTask => Boolean(task));
    const materials = materialsByOrder.get(order.orderNo) ?? [];
    const dueMs = order.dueAt ? Date.parse(order.dueAt) : Number.NaN;
    const gaps: string[] = [];
    if (tasks.length === 0) gaps.push('task_link_missing');
    if (tasks.length > 0 && tasks.every((task) => task.stepCount === 0)) gaps.push('steps_missing');
    if (materials.length === 0) gaps.push('material_link_missing');
    if (!order.dueAt || !Number.isFinite(dueMs)) gaps.push('due_at_missing');
    const notes: string[] = [];
    if (tasks.some((task) => task.openStepCount > 0)) {
      notes.push(
        `未完成工序 ${tasks.reduce((sum, task) => sum + task.openStepCount, 0)} 道`
        + `（共 ${tasks.reduce((sum, task) => sum + task.stepCount, 0)} 道）`,
      );
    }
    if (materials.some((material) => material.shortage > 0)) {
      notes.push(`物料缺口 ${materials.filter((m) => m.shortage > 0).length} 项（短缺合计 ${materials.reduce((sum, m) => sum + Math.max(0, m.shortage), 0)}）`);
    }
    if (materials.some((material) => material.belowThreshold)) {
      notes.push(`低于再订货点 ${materials.filter((m) => m.belowThreshold).length} 项`);
    }
    return {
      orderNo: order.orderNo,
      status: order.status,
      priority: order.priority ?? null,
      dueAt: order.dueAt && Number.isFinite(dueMs) ? order.dueAt : null,
      overdue: Number.isFinite(dueMs) ? dueMs < nowMs : null,
      tasks,
      materials,
      gaps,
      assignedTaskCount: tasks.filter((task) => task.stepIds.length > 0 || task.status !== 'draft').length,
      notes,
    };
  });

  return views
    .sort((a, b) => {
      const overdueRank = (view: OrderChainView) => (view.overdue === true ? 0 : view.overdue === false ? 1 : 2);
      const byOverdue = overdueRank(a) - overdueRank(b);
      if (byOverdue !== 0) return byOverdue;
      const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
      const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
      return a.orderNo.localeCompare(b.orderNo);
    })
    .slice(0, limit);
}

/** 汇总统计（页面顶部一行：多少单、多少断链、多少逾期）。 */
export function summarizeOrderChains(chains: readonly OrderChainView[]): {
  orders: number;
  overdue: number;
  withGaps: number;
  gapCounts: Record<string, number>;
  materialsInShortage: number;
  openSteps: number;
} {
  const gapCounts: Record<string, number> = {};
  for (const chain of chains) {
    for (const gap of chain.gaps) gapCounts[gap] = (gapCounts[gap] ?? 0) + 1;
  }
  return {
    orders: chains.length,
    overdue: chains.filter((chain) => chain.overdue === true).length,
    withGaps: chains.filter((chain) => chain.gaps.length > 0).length,
    gapCounts,
    materialsInShortage: chains.reduce(
      (sum, chain) => sum + chain.materials.filter((material) => material.shortage > 0).length,
      0,
    ),
    openSteps: chains.reduce(
      (sum, chain) => sum + chain.tasks.reduce((taskSum, task) => taskSum + task.openStepCount, 0),
      0,
    ),
  };
}

/** 工序未完成数（供服务层复用同一口径）。 */
export function countOpenSteps(steps: ReadonlyArray<{ status?: string | null }>): number {
  return steps.filter((step) => !TERMINAL_STEP_STATUSES.has(String(step.status ?? '').toLowerCase())).length;
}
