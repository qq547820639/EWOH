/* MaterialsService 一等实体读面回归（P4-material-master / 议题 R-2，standalone_099）。
 *
 * 锁定的不变量：**缺口读不到时说读不到，不说 0**。
 *
 * 背景：此前物料库存只能从 ewoh_event 的自由格式载荷投影，而投影里
 * `Number(null ?? 0) === 0` 会把「读不到」静默变成「库存 0」——现场据此判定
 * 「没料了」或「够用」，两个方向都会做出错误决策。新实体（ewoh_material /
 * ewoh_material_stock / ewoh_material_requirement）把 quantity_status 与
 * quantity 用 DB CHECK 绑定（unknown ⟺ quantity IS NULL），读面**没有任何数字**
 * 可以被当成 0。本 spec 在单元层把这个语义钉死。
 *
 * 覆盖：
 *  1. 按物料合并：实体行保留、事件-only 物料不消失（事件投影永远计算，而非二选一）
 *  2. ★ unknown 库存 → onHand=null（未知）而不是 0，并出现在 unparsable
 *  3. unknown 需求 → 不并入合计，显式列入 invalidOrders
 *  4. 阈值取最新一条；未声明阈值 → minThreshold=null（不猜）
 *  5. 实体表为空 → 回退事件投影（历史/未迁移租户形状不变）
 *  6. org 缺失 → 400（RLS 下不静默读全局）
 * DB 以 fake 替换（单元层不依赖真实 PG）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { MaterialsService } from './materials.service';
import { ewohEvent, ewohMaterial, ewohMaterialRequirement } from '@server/database/schema';

const ORG_A = 'org-a';

/** 收集 drizzle sql 模板的字符串片段（与 learning.service.spec 同款）。 */
function sqlText(query: unknown): string {
  const q = query as { queryChunks?: unknown[] };
  if (Array.isArray(q?.queryChunks)) {
    return q.queryChunks
      .map((c) => {
        if (typeof c === 'string') return c;
        const chunk = c as { value?: unknown };
        if (Array.isArray(chunk?.value)) return chunk.value.filter((x) => typeof x === 'string').join('');
        return '';
      })
      .join('');
  }
  return '';
}

interface Fixtures {
  materials?: Array<Record<string, unknown>>;
  stocks?: Array<Record<string, unknown>>;
  requirements?: Array<Record<string, unknown>>;
  /** 事件投影聚合行（回退路径用）。 */
  movementAggRows?: Array<Record<string, unknown>>;
  eventRows?: Array<Record<string, unknown>>;
}

function createDb(fixtures: Fixtures = {}) {
  const executeCalls: string[] = [];
  const db = {
    execute: jest.fn(async (query: unknown) => {
      const text = sqlText(query);
      executeCalls.push(text);
      if (text.includes('ewoh_material_stock')) return fixtures.stocks ?? [];
      // 事件投影的"无法解析"探测查询（回退路径）→ 恒空
      if (text.includes('materialMovementParse')) return [];
      if (text.includes('ewoh_event')) return fixtures.movementAggRows ?? [];
      return [];
    }),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const rows = table === ewohMaterial
          ? (fixtures.materials ?? [])
          : table === ewohMaterialRequirement
            ? (fixtures.requirements ?? [])
            : table === ewohEvent
              ? (fixtures.eventRows ?? [])
              : [];
        const q = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
        q.where = () => q;
        q.orderBy = () => q;
        q.limit = () => q;
        return q;
      }),
    })),
  };
  const service = new MaterialsService(db as never);
  return { db, service, executeCalls };
}

const MATERIALS = [
  { materialId: 'MAT-WELD-WIRE', materialCode: 'MAT-WELD-WIRE', name: '焊丝', unit: 'kg', category: '耗材', status: 'active' },
  { materialId: 'MAT-PACK-BOX', materialCode: 'MAT-PACK-BOX', name: '包装箱', unit: '件', category: '包装', status: 'active' },
  { materialId: 'MAT-COVER-EXT', materialCode: 'MAT-COVER-EXT', name: '外观件', unit: '件', category: '外观件', status: 'active' },
];

function stockRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    location_id: 'WH-A',
    stock_id: 'STK-1',
    quantity_status: 'known',
    quantity: '10',
    unit: '件',
    observed_at: '2026-09-01T00:00:00.000Z',
    source_kind: 'erp_receipt',
    source_ref: 'RCPT-1',
    ...over,
  };
}

function requirementRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    requirementId: 'REQ-1',
    requirementType: 'threshold',
    quantityStatus: 'known',
    quantity: '20',
    unit: '件',
    sourceKind: 'erp_master',
    sourceRef: null,
    dueAt: null,
    effectiveAt: new Date('2026-08-31T00:00:00.000Z'),
    status: 'open',
    ...over,
  };
}

describe('MaterialsService 一等实体读面（P4/R-2）', () => {
  it('org 缺失显式 400（不静默读全局）', async () => {
    const { service } = createDb();
    await expect(service.getInventory({} as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('★ 库存读不到 → onHand=null（未知），绝不写成 0，且出现在 unparsable', async () => {
    const { service } = createDb({
      materials: MATERIALS,
      stocks: [
        // 已知库存：焊丝 8.5kg（阈值 20 → 低于再订货点）
        stockRow({ material_id: 'MAT-WELD-WIRE', stock_id: 'STK-W', quantity: '8.5', unit: 'kg', location_id: 'WH-B' }),
        // ★ 读不到：包装箱数量未知
        stockRow({
          material_id: 'MAT-PACK-BOX', stock_id: 'STK-U', location_id: 'WH-C',
          quantity_status: 'unknown', quantity: null,
        }),
      ],
      requirements: [
        requirementRow({ requirementId: 'REQ-W', materialId: 'MAT-WELD-WIRE', quantity: '20', unit: 'kg' }),
        requirementRow({ requirementId: 'REQ-U', materialId: 'MAT-PACK-BOX', quantity: '100', unit: '件' }),
      ],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);

    // 1) 未知库存的物料**没有** balance（不给出任何数字）
    expect(result.balances.find((b) => b.materialId === 'MAT-PACK-BOX')).toBeUndefined();
    // 2) 但它必须在 impact 里以"未知"出现（onHand=null），而不是 0
    const unknownRow = result.impact.find((r) => r.materialId === 'MAT-PACK-BOX');
    expect(unknownRow).toBeDefined();
    expect(unknownRow?.onHand).toBeNull();
    expect(unknownRow?.onHand).not.toBe(0);
    // 未知库存不得被算成"低于阈值"（onHand 未知，无法比较）
    expect(unknownRow?.thresholdGap).toBeNull();
    // 3) 原因看得见：unparsable 显式列出该库存事实
    expect(result.unparsable).toHaveLength(1);
    expect(result.unparsable[0]?.type).toBe('stock_quantity_unknown');
    expect(result.unparsable[0]?.eventId).toBe('STK-U');
    expect(result.unparsable[0]?.reason).toContain('读不到');

    // 已知库存仍正常投影：8.5 < 20 → 低于再订货点
    const knownRow = result.impact.find((r) => r.materialId === 'MAT-WELD-WIRE');
    expect(knownRow?.onHand).toBe(8.5);
    expect(knownRow?.minThreshold).toBe(20);
    expect(knownRow?.status).toBe('below_threshold');
  });

  it('按物料合并：实体行保留、事件-only 物料不消失（e2e:materials 回归）', async () => {
    const { service, executeCalls } = createDb({
      materials: MATERIALS,
      stocks: [stockRow({ material_id: 'MAT-COVER-EXT', stock_id: 'STK-C', quantity: '30', unit: '件', location_id: 'LINE-B', source_kind: 'manual_count' })],
      requirements: [
        requirementRow({
          requirementId: 'REQ-MO1', materialId: 'MAT-COVER-EXT', requirementType: 'demand',
          quantity: '60', unit: '件', sourceKind: 'erp_order', sourceRef: 'MO-1',
          dueAt: new Date('2026-09-20T00:00:00.000Z'),
        }),
      ],
      // 事件-only 物料（未建主数据）：e2e:materials 正是这样经 ERP 事件造数据的。
      movementAggRows: [{
        material_id: 'MAT-EVT-ONLY',
        on_hand: '15',
        movement_count: '2',
        receipts: '1',
        consumptions: '1',
        units: ['件'],
        last_movement_at: new Date('2026-09-13T00:00:00.000Z'),
        min_threshold: '40',
        threshold_declared_at: new Date('2026-09-13T00:00:00.000Z'),
        evidence_ids: ['EVT-1', 'EVT-2'],
      }],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);

    // 实体物料照常投影（缺口来自实体需求）。
    const row = result.impact.find((r) => r.materialId === 'MAT-COVER-EXT');
    expect(row?.onHand).toBe(30);
    expect(row?.requiredQuantity).toBe(60);
    expect(row?.demandGap).toBe(30);
    expect(row?.status).toBe('below_demand');
    expect(row?.affectedOrders[0]?.externalOrderId).toBe('MO-1');
    // 事件-only 物料**必须**仍在（旧"实体非空即整体早返回"的语义下它会从读面
    // 消失——e2e:materials 14 项 FAIL 的根因）。
    const evt = result.balances.find((b) => b.materialId === 'MAT-EVT-ONLY');
    expect(evt?.onHand).toBe(15);
    expect(evt?.minThreshold).toBe(40);
    expect(evt?.evidenceIds).toEqual(['EVT-1', 'EVT-2']);
    // 两个来源都被读过（合并语义：事件投影永远计算，而不是二选一）。
    expect(executeCalls.some((t) => t.includes('ewoh_material_stock'))).toBe(true);
    expect(executeCalls.some((t) => t.includes('materialMovement'))).toBe(true);
    expect(result.aggregationNote).toContain('合并');
    expect(result.scannedOrders).toBe(1);
  });

  it('实体库存未知压过事件数字（未知 ≠ 任何数字）', async () => {
    const { service } = createDb({
      materials: MATERIALS,
      stocks: [
        stockRow({
          material_id: 'MAT-PACK-BOX', stock_id: 'STK-U', location_id: 'WH-C',
          quantity_status: 'unknown', quantity: null,
        }),
      ],
      requirements: [
        requirementRow({ requirementId: 'REQ-U', materialId: 'MAT-PACK-BOX', quantity: '100', unit: '件' }),
      ],
      // 事件投影给同一个物料算出了数字：实体说"读不到"必须赢。
      movementAggRows: [{
        material_id: 'MAT-PACK-BOX',
        on_hand: '99',
        movement_count: '1',
        receipts: '1',
        consumptions: '0',
        units: ['件'],
        last_movement_at: new Date('2026-09-13T00:00:00.000Z'),
        min_threshold: null,
        threshold_declared_at: null,
        evidence_ids: ['EVT-9'],
      }],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);

    // 不给任何数字（99 来自事件，但实体权威说未知 → 不出 balance）。
    expect(result.balances.find((b) => b.materialId === 'MAT-PACK-BOX')).toBeUndefined();
    // 未知行保留（读不到必须可见，不能静默变成 99 或 0）。
    const unknownRow = result.impact.find((r) => r.materialId === 'MAT-PACK-BOX');
    expect(unknownRow?.onHand).toBeNull();
    expect(result.unparsable.some((u) => u.eventId === 'STK-U')).toBe(true);
  });

  it('按物料合并：实体只覆盖需求（无库存事实）时，事件库存数字不得被抹成"未知"', async () => {
    // 回归：mergeInventoryViews 此前从"impact 里 onHand=null 的行"反推实体未知物料，
    // 把"实体没有任何库存事实（只有需求行）"也当成"实体说库存读不到"，于是事件侧
    // 真实的 500 件库存被整体压掉——已知事实被伪造成"未知"（合并销毁事实，正是
    // 本模块要消灭的反向伪造）。正确语义：只有实体**显式声明**读不到（有 stock 行
    // 且 quantity_status='unknown'）才压过事件数字；实体没覆盖库存 → 事件数字保留。
    const { service } = createDb({
      materials: MATERIALS,
      stocks: [], // 实体没有该物料的任何库存事实——对库存"没有表态"
      requirements: [
        requirementRow({
          requirementId: 'REQ-MIX', materialId: 'MAT-WELD-WIRE', requirementType: 'demand',
          quantity: '100', unit: '件', sourceKind: 'erp_order', sourceRef: 'MO-MIX',
          dueAt: new Date('2026-09-20T00:00:00.000Z'),
        }),
      ],
      // 事件侧对该物料有真实出入库事实：onHand 500、再订货点 40。
      movementAggRows: [{
        material_id: 'MAT-WELD-WIRE',
        on_hand: '500',
        movement_count: '3',
        receipts: '3',
        consumptions: '0',
        units: ['件'],
        last_movement_at: new Date('2026-09-13T00:00:00.000Z'),
        min_threshold: '40',
        threshold_declared_at: new Date('2026-09-13T00:00:00.000Z'),
        evidence_ids: ['EVT-1', 'EVT-2', 'EVT-3'],
      }],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);

    // 事件侧的 500 件是已知事实：不得消失、不得变"未知"、不得变 0。
    expect(result.balances.find((b) => b.materialId === 'MAT-WELD-WIRE')?.onHand).toBe(500);
    const row = result.impact.find((r) => r.materialId === 'MAT-WELD-WIRE');
    expect(row?.onHand).toBe(500);
    // 实体需求照常生效（实体是它所覆盖维度的权威：需求 100 来自实体）。
    expect(row?.requiredQuantity).toBe(100);
    expect(row?.demandGap).toBe(-400);
    expect(row?.affectedOrders[0]?.externalOrderId).toBe('MO-MIX');
  });

  it('需求读不到 → 不并入合计（不按猜测计算），显式列入 invalidOrders', async () => {
    const { service } = createDb({
      materials: MATERIALS,
      requirements: [
        requirementRow({
          requirementId: 'REQ-UNK', materialId: 'MAT-MODULE-A', requirementType: 'demand',
          quantityStatus: 'unknown', quantity: null, sourceKind: 'erp_order', sourceRef: 'MO-UNK',
        }),
      ],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);

    expect(result.demand.demands.find((d) => d.materialId === 'MAT-MODULE-A')).toBeUndefined();
    expect(result.demand.invalidOrders).toHaveLength(1);
    expect(result.demand.invalidOrders[0]?.externalOrderId).toBe('MO-UNK');
    expect(result.demand.invalidOrders[0]?.reason).toContain('读不到');
  });

  it('阈值未声明 → minThreshold=null（不猜默认值）', async () => {
    const { service } = createDb({
      materials: MATERIALS,
      stocks: [stockRow({ material_id: 'MAT-WELD-WIRE', stock_id: 'STK-W', quantity: '5', unit: 'kg' })],
      requirements: [
        requirementRow({
          requirementId: 'REQ-UNK-THR', materialId: 'MAT-WELD-WIRE', requirementType: 'threshold',
          quantityStatus: 'unknown', quantity: null, unit: 'kg',
        }),
      ],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);
    const row = result.impact.find((r) => r.materialId === 'MAT-WELD-WIRE');
    expect(row?.minThreshold).toBeNull();
    expect(row?.status).toBe('no_threshold');
  });

  it('实体表为空 → 回退事件投影（未迁移租户形状不变）', async () => {
    const { service, executeCalls } = createDb({
      materials: [],
      stocks: [],
      requirements: [],
      movementAggRows: [
        {
          material_id: 'MAT-EVT-1',
          on_hand: '15',
          movement_count: '3',
          receipts: '3',
          consumptions: '0',
          units: ['件'],
          last_movement_at: new Date('2026-09-01T00:00:00.000Z'),
          min_threshold: '10',
          threshold_declared_at: new Date('2026-09-01T00:00:00.000Z'),
          evidence_ids: ['evt-1', 'evt-2', 'evt-3'],
        },
      ],
      eventRows: [],
    });

    const result = await service.getInventory({ primaryOrgId: ORG_A } as never);

    expect(result.balances).toHaveLength(1);
    expect(result.balances[0]?.materialId).toBe('MAT-EVT-1');
    expect(result.balances[0]?.onHand).toBe(15);
    expect(result.impact[0]?.status).toBe('ok');
    // 实体探测跑过（返回空）→ 才回退到 ewoh_event 聚合
    expect(executeCalls.some((t) => t.includes('ewoh_material_stock'))).toBe(true);
    expect(executeCalls.some((t) => t.includes('materialMovement'))).toBe(true);
  });
});
