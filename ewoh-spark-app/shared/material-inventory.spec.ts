/* 物料流动契约与库存投影测试（NO-27a）。
 *
 * 钉死的语义：
 *   1. 形状非法 → invalid（fail-closed）；历史自由格式载荷 → legacy（不判错、不被采用）；
 *   2. 数量缺失/非数/非正 → 显式错误（不做 Number(null)=0 的静默伪造）；
 *   3. 库存 = 入库 − 领用；为负如实标记（账实不符信号）；
 *   4. 同物料多单位 → **不求和**，标记 mixedUnits；
 *   5. 没声明再订货点的物料 → 不产出事实（`no_threshold`），不编阈值；
 *   6. 事实带可追溯证据（参与投影的事件 id）。
 */
/// <reference types="jest" />
import {
  buildMaterialImpact,
  collectMaterialFacts,
  isBomBasis,
  isMaterialMovementType,
  parseMaterialMovement,
  projectMaterialDemand,
  projectMaterialInventory,
} from './material-inventory';

describe('parseMaterialMovement', () => {
  it('合法入库（含再订货点）→ ok，字段规范化', () => {
    const result = parseMaterialMovement(
      'inventory_receipt',
      { material_id: 'MAT-1', quantity: '120', unit: 'kg', min_threshold: 40, sourceRef: 'PO-1' },
      { at: '2026-09-12T10:00:00.000Z' },
    );
    expect(result.status).toBe('ok');
    expect(result.movement).toEqual({
      type: 'inventory_receipt',
      materialId: 'MAT-1',
      quantity: 120,
      unit: 'kg',
      minThreshold: 40,
      sourceRef: 'PO-1',
      at: '2026-09-12T10:00:00.000Z',
    });
  });

  it('完全不含物料字段的历史载荷 → legacy（不判错也不采用）', () => {
    const result = parseMaterialMovement('material_consumption', { note: 'MES 汇总' });
    expect(result.status).toBe('legacy');
    expect(result.movement).toBeUndefined();
  });

  it('非物料类型 → legacy（与物料无关的 ERP 出站不受影响）', () => {
    expect(parseMaterialMovement('production_report', { anything: 1 }).status).toBe('legacy');
    expect(isMaterialMovementType('production_report')).toBe(false);
  });

  it('含物料字段但形状非法 → invalid + 逐条原因（fail-closed）', () => {
    expect(parseMaterialMovement('material_consumption', { quantity: 5 }).errors).toContain('materialId 必填');
    expect(parseMaterialMovement('material_consumption', { materialId: 'M', quantity: 'abc' }).errors.join(' ')).toContain(
      'quantity 必须是有限数',
    );
    expect(parseMaterialMovement('material_consumption', { materialId: 'M', quantity: -3 }).errors.join(' ')).toContain(
      'quantity 必须为正数',
    );
    expect(
      parseMaterialMovement('inventory_receipt', { materialId: 'M', quantity: 1, minThreshold: -1 }).errors.join(' '),
    ).toContain('minThreshold 必须是非负有限数');
  });

  it('数量为 0 / 缺失 → 显式错误（0 不是"没填"）', () => {
    expect(parseMaterialMovement('material_consumption', { materialId: 'M', quantity: 0 }).errors.join(' ')).toContain(
      'quantity 必须为正数',
    );
    expect(parseMaterialMovement('material_consumption', { materialId: 'M' }).errors).toContain('quantity 必填');
  });
});

describe('projectMaterialInventory', () => {
  const movement = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'EV-1',
    type: 'inventory_receipt' as const,
    movement: {
      type: 'inventory_receipt' as const,
      materialId: 'MAT-1',
      quantity: 100,
      unit: 'kg',
      minThreshold: 40,
      sourceRef: null,
      at: '2026-09-12T09:00:00.000Z',
      ...overrides,
    },
    at: '2026-09-12T09:00:00.000Z',
  });

  it('入库累加、领用累减，阈值取最近一次声明，证据可追溯', () => {
    const projection = projectMaterialInventory([
      movement({ eventId: 'EV-1' } as never),
      {
        eventId: 'EV-2',
        type: 'material_consumption',
        movement: {
          type: 'material_consumption',
          materialId: 'MAT-1',
          quantity: 30,
          unit: 'kg',
          minThreshold: null,
          sourceRef: null,
          at: '2026-09-12T09:30:00.000Z',
        },
        at: '2026-09-12T09:30:00.000Z',
      },
      {
        eventId: 'EV-3',
        type: 'inventory_receipt',
        movement: {
          type: 'inventory_receipt',
          materialId: 'MAT-1',
          quantity: 10,
          unit: 'kg',
          minThreshold: 55,
          sourceRef: null,
          at: '2026-09-12T09:45:00.000Z',
        },
        at: '2026-09-12T09:45:00.000Z',
      },
    ]);

    const balance = projection.balances[0];
    expect(balance).toMatchObject({
      materialId: 'MAT-1',
      onHand: 80,
      unit: 'kg',
      minThreshold: 55,
      receipts: 2,
      consumptions: 1,
      movementCount: 3,
      negative: false,
      mixedUnits: false,
    });
    expect(balance.evidenceIds).toEqual(['EV-1', 'EV-2', 'EV-3']);
    expect(balance.lastMovementAt).toBe('2026-09-12T09:45:00.000Z');
  });

  it('领用多于入库 → 负库存如实标记（不是 0，也不是报错）', () => {
    const projection = projectMaterialInventory([
      movement({ eventId: 'EV-1', quantity: 5 } as never),
      {
        eventId: 'EV-2',
        type: 'material_consumption',
        movement: {
          type: 'material_consumption',
          materialId: 'MAT-1',
          quantity: 8,
          unit: 'kg',
          minThreshold: null,
          sourceRef: null,
          at: '2026-09-12T09:30:00.000Z',
        },
        at: '2026-09-12T09:30:00.000Z',
      },
    ]);
    expect(projection.balances[0].onHand).toBe(-3);
    expect(projection.balances[0].negative).toBe(true);
  });

  it('同物料多单位 → 不求和、标记 mixedUnits（拒绝把 kg 与 件 相加）', () => {
    const projection = projectMaterialInventory([
      movement({ eventId: 'EV-1', quantity: 10, unit: 'kg' } as never),
      movement({ eventId: 'EV-2', quantity: 3, unit: '件' } as never),
    ]);
    expect(projection.balances[0]).toMatchObject({ mixedUnits: true, unit: null });
  });

  it('没有事件 → 空库存（不凭空造物料）', () => {
    expect(projectMaterialInventory([]).balances).toEqual([]);
  });
});

describe('collectMaterialFacts', () => {
  const projection = (overrides: Record<string, unknown> = {}) => ({
    balances: [
      {
        materialId: 'MAT-1',
        onHand: 12,
        unit: 'kg',
        minThreshold: 40,
        thresholdDeclaredAt: '2026-09-12T09:00:00.000Z',
        receipts: 1,
        consumptions: 1,
        movementCount: 2,
        lastMovementAt: '2026-09-12T09:30:00.000Z',
        negative: false,
        mixedUnits: false,
        evidenceIds: ['EV-1', 'EV-2'],
        ...overrides,
      },
    ],
    unparsable: [],
    generatedAt: '2026-09-12T10:00:00.000Z',
  });

  it('有库存 + 有阈值 → 产出 material 事实（引擎据此判短缺）', () => {
    const { facts, skipped } = collectMaterialFacts(projection());
    expect(skipped).toEqual([]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      subjectId: 'material:MAT-1',
      kind: 'material',
      values: { inventory: 12, minThreshold: 40, negativeOnHand: false },
      evidenceIds: ['event:EV-1', 'event:EV-2'],
    });
  });

  it('没有阈值 → 不产出事实并说明原因（不编默认阈值）', () => {
    const { facts, skipped } = collectMaterialFacts(projection({ minThreshold: null }));
    expect(facts).toEqual([]);
    expect(skipped[0]).toMatchObject({ reason: 'no_threshold', subjectId: 'material:MAT-1' });
  });

  it('单位不一致 → 不产出事实（先统一单位）', () => {
    const { facts, skipped } = collectMaterialFacts(projection({ mixedUnits: true, unit: null }));
    expect(facts).toEqual([]);
    expect(skipped[0].reason).toBe('mixed_units');
  });

  it('负库存仍产出事实但带上账实不符标记（可见，不隐藏）', () => {
    const { facts } = collectMaterialFacts(projection({ onHand: -5, negative: true }));
    expect(facts[0].values).toMatchObject({ inventory: -5, negativeOnHand: true });
  });

  it('无投影 → 空（不报错）', () => {
    expect(collectMaterialFacts(null)).toEqual({ facts: [], skipped: [] });
  });
});

describe('projectMaterialDemand（订单 BOM → 需求）', () => {
  const NOW = Date.parse('2026-09-12T10:00:00.000Z');
  const order = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'ERP-O-1',
    externalOrderId: 'SO-1',
    quantity: 10,
    bom: [{ materialId: 'MAT-1', quantity: 2 }],
    dueAt: '2026-09-20T00:00:00.000Z',
    basis: 'per_unit' as const,
    ...overrides,
  });

  it('per_unit：需求 = BOM 用量 × 订单数量（并按物料聚合、带订单证据）', () => {
    const projection = projectMaterialDemand([order(), order({ eventId: 'ERP-O-2', externalOrderId: 'SO-2', quantity: 5 })], {
      nowMs: NOW,
    });
    expect(projection.unknownBasisOrders).toEqual([]);
    expect(projection.demands).toHaveLength(1);
    expect(projection.demands[0]).toMatchObject({ materialId: 'MAT-1', requiredQuantity: 30 });
    expect(projection.demands[0].orders.map((o) => o.externalOrderId)).toEqual(['SO-1', 'SO-2']);
    expect(projection.demands[0].evidenceIds).toEqual(['ERP-O-1', 'ERP-O-2']);
    expect(projection.demands[0].hasOverdue).toBe(false);
  });

  it('per_order：需求 = BOM 用量本身（不乘订单数量）', () => {
    const projection = projectMaterialDemand([order({ basis: 'per_order' })], { nowMs: NOW });
    expect(projection.demands[0].requiredQuantity).toBe(2);
  });

  it('口径未声明 → **不计算**，单独列出（猜错就是几倍的缺口）', () => {
    const projection = projectMaterialDemand([order({ basis: null })], { nowMs: NOW });
    expect(projection.demands).toEqual([]);
    expect(projection.unknownBasisOrders[0]).toMatchObject({ externalOrderId: 'SO-1' });
    expect(projection.unknownBasisOrders[0].reason).toContain('未声明');
  });

  it('脏数据逐条隔离：订单数量非法 / BOM 行非法（不因一条脏数据丢掉整批）', () => {
    const projection = projectMaterialDemand(
      [
        order({ eventId: 'ERP-O-BAD', externalOrderId: 'SO-BAD', quantity: -1 }),
        order({ eventId: 'ERP-O-BAD2', externalOrderId: 'SO-BAD2', bom: [{ materialId: '', quantity: 2 }] }),
        order({ eventId: 'ERP-O-OK', externalOrderId: 'SO-OK' }),
      ],
      { nowMs: NOW },
    );
    expect(projection.invalidOrders.map((o) => o.externalOrderId)).toEqual(['SO-BAD', 'SO-BAD2']);
    expect(projection.demands[0].requiredQuantity).toBe(20);
  });

  it('逾期未完工订单如实标记（逾期需求更要紧）', () => {
    const projection = projectMaterialDemand([order({ dueAt: '2026-09-01T00:00:00.000Z' })], { nowMs: NOW });
    expect(projection.demands[0].hasOverdue).toBe(true);
  });

  it('无 BOM 订单不产生需求（不报错）', () => {
    expect(projectMaterialDemand([order({ bom: [] })], { nowMs: NOW }).demands).toEqual([]);
    expect(isBomBasis('per_unit')).toBe(true);
    expect(isBomBasis('whatever')).toBe(false);
  });
});

describe('buildMaterialImpact（库存 × 需求 → 可行动的缺口）', () => {
  const inventory = (onHand: number, overrides: Record<string, unknown> = {}) => ({
    balances: [
      {
        materialId: 'MAT-1',
        onHand,
        unit: 'kg',
        minThreshold: 40,
        thresholdDeclaredAt: '2026-09-12T09:00:00.000Z',
        receipts: 1,
        consumptions: 1,
        movementCount: 2,
        lastMovementAt: '2026-09-12T09:30:00.000Z',
        negative: onHand < 0,
        mixedUnits: false,
        evidenceIds: ['event:EV-1'],
        ...overrides,
      },
    ],
    unparsable: [],
    generatedAt: '2026-09-12T10:00:00.000Z',
  });
  const demand = (requiredQuantity: number, overrides: Record<string, unknown> = {}) => ({
    demands: [
      {
        materialId: 'MAT-1',
        requiredQuantity,
        unit: null,
        bomUnits: [],
        orders: [{ externalOrderId: 'SO-1', eventId: 'ERP-O-1', requiredQuantity, orderQuantity: 10, dueAt: null }],
        evidenceIds: ['ERP-O-1'],
        hasOverdue: false,
        ...overrides,
      },
    ],
    unknownBasisOrders: [],
    invalidOrders: [],
    generatedAt: '2026-09-12T10:00:00.000Z',
  });

  it('需求 > 库存 → below_demand（比"低于再订货点"更紧迫），并给出缺口与受影响订单', () => {
    const rows = buildMaterialImpact(inventory(100), demand(150));
    expect(rows[0]).toMatchObject({
      status: 'below_demand',
      onHand: 100,
      requiredQuantity: 150,
      demandGap: 50,
      thresholdGap: -60,
    });
    expect(rows[0].affectedOrders.map((o) => o.externalOrderId)).toEqual(['SO-1']);
    expect(rows[0].evidenceIds).toEqual(['event:EV-1', 'ERP-O-1']);
  });

  it('需求可覆盖但低于再订货点 → below_threshold；两者都满足 → ok', () => {
    expect(buildMaterialImpact(inventory(30), demand(10))[0].status).toBe('below_threshold');
    expect(buildMaterialImpact(inventory(100), demand(10))[0].status).toBe('ok');
  });

  it('只有需求没有库存记录 → 库存未知（不是 0，也不假装短缺）', () => {
    const rows = buildMaterialImpact({ balances: [], unparsable: [], generatedAt: 'x' }, demand(10));
    expect(rows[0]).toMatchObject({ status: 'no_movements', onHand: null, requiredQuantity: 10 });
    expect(rows[0].statusLabel).toContain('库存未知');
  });

  it('没有声明阈值 → no_threshold（不判定短缺，但需求照旧可见）', () => {
    const rows = buildMaterialImpact(inventory(10, { minThreshold: null }), demand(5));
    expect(rows[0]).toMatchObject({ status: 'no_threshold', minThreshold: null, requiredQuantity: 5 });
  });

  it('单位不一致 → mixed_units 优先（数量无法合并就别谈缺口）', () => {
    const rows = buildMaterialImpact(inventory(10, { mixedUnits: true, unit: null }), demand(5));
    expect(rows[0].status).toBe('mixed_units');
  });

  it('库存单位与 BOM 单位不一致 → unit_mismatch（不做比较，不编缺口）', () => {
    const rows = buildMaterialImpact(inventory(15), demand(60, { bomUnits: ['件'], unit: '件' }));
    expect(rows[0]).toMatchObject({ status: 'unit_mismatch', onHand: 15, requiredQuantity: 60 });
    expect(rows[0].statusLabel).toContain('单位不一致');
  });

  it('BOM 自身多种单位 → 同样不比较（unit_mismatch 优先于缺口计算）', () => {
    const rows = buildMaterialImpact(inventory(15), demand(60, { bomUnits: ['kg', '件'], unit: null }));
    expect(rows[0].status).toBe('unit_mismatch');
  });

  it('单位一致时正常比较（不误报）', () => {
    const rows = buildMaterialImpact(inventory(100), demand(60, { bomUnits: ['kg'], unit: 'kg' }));
    expect(rows[0].status).toBe('ok');
  });

  it('需求侧未声明单位 → 不阻断比较，但库存单位仍然显示（信息不完整时如实呈现）', () => {
    const rows = buildMaterialImpact(inventory(15), demand(60, { bomUnits: [], unit: null }));
    expect(rows[0].status).toBe('below_demand');
    expect(rows[0].unit).toBe('kg');
  });

  it('空输入 → 空结果（不凭空造物料）', () => {
    expect(buildMaterialImpact(null, null)).toEqual([]);
  });
});
