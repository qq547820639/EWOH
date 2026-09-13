import {
  ORDER_CHAIN_DEFAULT_LIMIT,
  buildOrderChains,
  countOpenSteps,
  summarizeOrderChains,
  type BuildOrderChainsInput,
  type OrderChainMaterial,
  type OrderChainTask,
} from './order-chain';

const NOW = '2026-09-12T08:00:00.000Z';

function task(overrides: Partial<OrderChainTask> = {}): OrderChainTask {
  return {
    taskId: 'WO-1001',
    title: '装配工单',
    status: 'executing',
    source: 'mes',
    planStart: '2026-09-12T09:00:00.000Z',
    planEnd: '2026-09-12T17:00:00.000Z',
    stepCount: 3,
    openStepCount: 2,
    stepIds: ['WO-1001-S1', 'WO-1001-S2'],
    ...overrides,
  };
}

function material(overrides: Partial<OrderChainMaterial> = {}): OrderChainMaterial {
  return {
    materialId: 'MAT-1',
    name: '轴承',
    unit: 'pcs',
    requiredTotal: 100,
    onHand: 80,
    shortage: 20,
    belowThreshold: false,
    orderNos: ['WO-1001'],
    ...overrides,
  };
}

function input(overrides: Partial<BuildOrderChainsInput> = {}): BuildOrderChainsInput {
  return {
    now: NOW,
    orders: [{ orderId: 'WO-1001', orderNo: 'WO-1001', status: 'open', priority: 'high', dueAt: '2026-09-13T08:00:00.000Z' }],
    tasks: [task()],
    materials: [material()],
    ...overrides,
  };
}

describe('buildOrderChains（订单 → 任务 → 物料链路）', () => {
  it('完整链路：任务（含工序计数）与物料都挂上，无缺口', () => {
    const [chain] = buildOrderChains(input());
    expect(chain.orderNo).toBe('WO-1001');
    expect(chain.tasks.map((t) => t.taskId)).toEqual(['WO-1001']);
    expect(chain.tasks[0].openStepCount).toBe(2);
    expect(chain.materials.map((m) => m.materialId)).toEqual(['MAT-1']);
    expect(chain.gaps).toEqual([]);
    expect(chain.overdue).toBe(false);
    expect(chain.notes.join(' ')).toContain('未完成工序 2 道');
    expect(chain.notes.join(' ')).toContain('物料缺口 1 项');
  });

  it('链路靠"订单号 = 排产任务号"兜底（快照里 taskIds 为空也要能连上）', () => {
    const [chain] = buildOrderChains(input({
      orders: [{ orderId: 'WO-1001', orderNo: 'WO-1001', status: 'open', taskIds: [] }],
    }));
    expect(chain.tasks).toHaveLength(1);
    expect(chain.gaps).not.toContain('task_link_missing');
  });

  it('断链显式列出：无任务 / 无工序 / 无物料 / 无期限', () => {
    const [chain] = buildOrderChains(input({
      orders: [{ orderId: 'WO-X', orderNo: 'WO-X', status: 'open', dueAt: null }],
      tasks: [task({ taskId: 'WO-OTHER' })],
      materials: [],
    }));
    expect(chain.gaps).toEqual(
      expect.arrayContaining(['task_link_missing', 'material_link_missing', 'due_at_missing']),
    );
    expect(chain.overdue).toBeNull(); // 无期限 → 不猜是否逾期
  });

  it('有任务但没有任何工序行 → steps_missing（不假装"0 道待做"）', () => {
    const [chain] = buildOrderChains(input({
      tasks: [task({ stepCount: 0, openStepCount: 0, stepIds: [] })],
    }));
    expect(chain.gaps).toContain('steps_missing');
  });

  it('逾期优先、其次按期限升序、最后订单号稳定排序', () => {
    const chains = buildOrderChains(input({
      orders: [
        { orderId: 'A', orderNo: 'A', status: 'open', dueAt: '2026-09-20T08:00:00.000Z' },
        { orderId: 'B', orderNo: 'B', status: 'open', dueAt: '2026-09-11T08:00:00.000Z' }, // 逾期
        { orderId: 'C', orderNo: 'C', status: 'open', dueAt: null },
      ],
      tasks: [],
      materials: [],
    }));
    expect(chains.map((c) => c.orderNo)).toEqual(['B', 'A', 'C']);
    expect(chains[0].overdue).toBe(true);
  });

  it('条数上限（默认 20）', () => {
    const orders = Array.from({ length: 30 }, (_, i) => ({
      orderId: `WO-${i}`, orderNo: `WO-${i}`, status: 'open', dueAt: null,
    }));
    expect(buildOrderChains(input({ orders, tasks: [], materials: [] }))).toHaveLength(ORDER_CHAIN_DEFAULT_LIMIT);
    expect(buildOrderChains(input({ orders, tasks: [], materials: [], limit: 5 }))).toHaveLength(5);
  });
});

describe('summarizeOrderChains / countOpenSteps', () => {
  it('汇总：逾期数、有缺口数、缺口分布、短缺物料与未完成工序合计', () => {
    const chains = buildOrderChains(input({
      orders: [
        { orderId: 'A', orderNo: 'A', status: 'open', dueAt: '2026-09-01T00:00:00.000Z' },
        { orderId: 'B', orderNo: 'B', status: 'open', dueAt: null },
      ],
      tasks: [task({ taskId: 'A' })],
      materials: [material({ orderNos: ['A'] })],
    }));
    const summary = summarizeOrderChains(chains);
    expect(summary.orders).toBe(2);
    expect(summary.overdue).toBe(1);
    expect(summary.withGaps).toBe(1); // B 全断链
    expect(summary.gapCounts.task_link_missing).toBe(1);
    expect(summary.materialsInShortage).toBe(1);
    expect(summary.openSteps).toBe(2);
  });

  it('工序终态口径：completed/cancelled/skipped 不算未完成', () => {
    expect(countOpenSteps([
      { status: 'completed' },
      { status: 'CANCELLED' },
      { status: 'skipped' },
      { status: 'executing' },
      { status: null },
    ])).toBe(2);
  });
});
