/* 物料流动与库存投影（NO-27a）。
 *
 * 背景：`rule:material-shortage`（物料短缺）在推理引擎里早已注册，但**没有事实来源**——
 * 世界模型没有库存列，仓库里也没有物料台账。工厂里唯一权威的物料流动事实是
 * **ERP 出站事件**（`inventory_receipt` 入库 / `material_consumption` 领用），
 * 但它们此前只是塞在自由格式 `payload` 里，没有任何契约。
 *
 * 本文件给物料流动一个**可校验的契约**，并把事件投影成库存：
 *   · 数量必须是有限数（缺失/非法 → 显式错误，不做 `Number(null)=0` 的静默伪造）；
 *   · **单位必须一致**才相加：同物料出现多种单位 → 不求和、如实标记 `mixedUnits`
 *     （把 kg 和 件 加起来是伪造事实）；
 *   · 入库可声明 `minThreshold`（ERP 的再订货点）——没有声明阈值的物料**不判定短缺**
 *     （`no_threshold`），而不是拿一个编造的默认值去报警；
 *   · 库存为负（领用多于入库）如实标记：这是真实数据缺口信号，不是 0。
 */

import type { SkippedObservation } from './observation-facts';

export const MATERIAL_MOVEMENT_TYPES = ['inventory_receipt', 'material_consumption'] as const;
export type MaterialMovementType = (typeof MATERIAL_MOVEMENT_TYPES)[number];

export function isMaterialMovementType(value: unknown): value is MaterialMovementType {
  return (MATERIAL_MOVEMENT_TYPES as readonly string[]).includes(String(value ?? ''));
}

export interface MaterialMovement {
  type: MaterialMovementType;
  materialId: string;
  /** 数量（正数；方向由 type 决定）。 */
  quantity: number;
  unit: string | null;
  /** 入库时可选声明再订货点（ERP 主数据）。 */
  minThreshold: number | null;
  /** 外部单据号（幂等与追溯）。 */
  sourceRef: string | null;
  at: string;
}

export interface MaterialMovementParseResult {
  /** `ok` 可直接投影；`legacy` 是"没有物料字段的历史自由格式载荷"（不判错、不采用）。 */
  status: 'ok' | 'legacy' | 'invalid';
  movement?: MaterialMovement;
  errors: string[];
}

/**
 * 解析 ERP 出站载荷中的物料流动。
 *
 * 兼容策略（不破坏历史）：
 *   · 载荷里**完全不含**物料字段 → `legacy`（历史自由格式，显式标注"不可解析"，
 *     既不猜也不让既有集成炸掉）；
 *   · 含物料字段但形状非法 → `invalid`（fail-closed：宁可拒绝，也不写脏事实）。
 */
export function parseMaterialMovement(
  type: unknown,
  payload: unknown,
  options: { at?: string | null } = {},
): MaterialMovementParseResult {
  if (!isMaterialMovementType(type)) {
    return { status: 'legacy', errors: [] };
  }
  const record = (payload ?? {}) as Record<string, unknown>;
  const hasMaterialFields =
    record.materialId !== undefined ||
    record.material_id !== undefined ||
    record.quantity !== undefined ||
    record.minThreshold !== undefined ||
    record.min_threshold !== undefined;
  if (!hasMaterialFields) {
    return { status: 'legacy', errors: [] };
  }
  const errors: string[] = [];
  const materialId = String(record.materialId ?? record.material_id ?? '').trim();
  if (!materialId) errors.push('materialId 必填');
  const rawQuantity = record.quantity;
  if (rawQuantity === undefined || rawQuantity === null || rawQuantity === '') {
    errors.push('quantity 必填');
  }
  const quantity = Number(rawQuantity);
  if (rawQuantity !== undefined && rawQuantity !== null && rawQuantity !== '' && !Number.isFinite(quantity)) {
    errors.push(`quantity 必须是有限数（收到 ${String(rawQuantity)}）`);
  }
  if (Number.isFinite(quantity) && quantity <= 0) {
    errors.push('quantity 必须为正数（方向由 type 决定）');
  }
  const rawThreshold = record.minThreshold ?? record.min_threshold;
  let minThreshold: number | null = null;
  if (rawThreshold !== undefined && rawThreshold !== null && rawThreshold !== '') {
    minThreshold = Number(rawThreshold);
    if (!Number.isFinite(minThreshold) || minThreshold < 0) {
      errors.push(`minThreshold 必须是非负有限数（收到 ${String(rawThreshold)}）`);
    }
  }
  const unitRaw = record.unit;
  const unit = unitRaw === undefined || unitRaw === null || String(unitRaw).trim() === ''
    ? null
    : String(unitRaw).trim();
  if (errors.length > 0) return { status: 'invalid', errors };
  return {
    status: 'ok',
    errors: [],
    movement: {
      type: type as MaterialMovementType,
      materialId,
      quantity,
      unit,
      minThreshold,
      sourceRef: typeof record.sourceRef === 'string' ? record.sourceRef : null,
      at: options.at ?? new Date().toISOString(),
    },
  };
}

export interface MaterialMovementEventInput {
  eventId: string;
  type: MaterialMovementType;
  movement: MaterialMovement;
  /** 事件自身时间（ISO；用于排序与"最后一次流动"）。 */
  at: string;
}

export interface MaterialBalance {
  materialId: string;
  /** 现有量（入库 − 领用）。 */
  onHand: number;
  unit: string | null;
  /** 最近一次声明的再订货点（未声明 → null，不猜）。 */
  minThreshold: number | null;
  thresholdDeclaredAt: string | null;
  receipts: number;
  consumptions: number;
  movementCount: number;
  lastMovementAt: string;
  /** 领用多于入库（真实的账实不符信号，不是 0）。 */
  negative: boolean;
  /** 同物料出现多种单位 → 不求和，如实标记（不去猜换算）。 */
  mixedUnits: boolean;
  /** 参与投影的事件 id（可追溯）。 */
  evidenceIds: string[];
}

export interface MaterialInventoryProjection {
  balances: MaterialBalance[];
  /** 无法解析的历史载荷（显式列出：数据缺口要看得见）。 */
  unparsable: Array<{ eventId: string; type: string; reason: string }>;
  generatedAt: string;
}

/** 把物料流动事件投影成库存（入库累加、领用累减；单位不一致不求和）。 */
export function projectMaterialInventory(
  events: readonly MaterialMovementEventInput[],
  options: { nowMs?: number } = {},
): MaterialInventoryProjection {
  const generatedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const byMaterial = new Map<string, MaterialBalance & { units: Set<string> }>();

  for (const event of events) {
    const { movement } = event;
    let balance = byMaterial.get(movement.materialId);
    if (!balance) {
      balance = {
        materialId: movement.materialId,
        onHand: 0,
        unit: movement.unit,
        minThreshold: null,
        thresholdDeclaredAt: null,
        receipts: 0,
        consumptions: 0,
        movementCount: 0,
        lastMovementAt: movement.at,
        negative: false,
        mixedUnits: false,
        evidenceIds: [],
        units: new Set<string>(),
      };
      byMaterial.set(movement.materialId, balance);
    }
    if (movement.unit) balance.units.add(movement.unit);
    if (movement.type === 'inventory_receipt') {
      balance.onHand += movement.quantity;
      balance.receipts += 1;
      if (movement.minThreshold !== null) {
        balance.minThreshold = movement.minThreshold;
        balance.thresholdDeclaredAt = movement.at;
      }
    } else {
      balance.onHand -= movement.quantity;
      balance.consumptions += 1;
    }
    balance.movementCount += 1;
    if (String(movement.at) > String(balance.lastMovementAt)) balance.lastMovementAt = movement.at;
    balance.evidenceIds.push(event.eventId);
  }

  const balances: MaterialBalance[] = [...byMaterial.values()]
    .map(({ units, ...balance }) => ({
      ...balance,
      // 单位不一致时不把不同单位的数量相加：宁可标记"无法合并"，也不伪造总量
      mixedUnits: units.size > 1,
      unit: units.size === 1 ? [...units][0] : null,
      negative: balance.onHand < 0,
      onHand: Number(balance.onHand.toFixed(6)),
    }))
    .sort((a, b) => a.materialId.localeCompare(b.materialId));

  return { balances, unparsable: [], generatedAt };
}

/**
 * 规范身份清洗（kind 必须来自 identity 封闭注册表）。
 * 事件证据用 `event:`（与推理契约 evidenceIds 的要求一致）。
 */
function canonicalValue(raw: string): string {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 100);
}

/** 库存 → 推理事实（`rule:material-shortage`）：只在"有库存记录且声明了阈值"时判定。 */
export function collectMaterialFacts(projection: MaterialInventoryProjection | null): {
  facts: Array<{ subjectId: string; kind: 'material'; values: Record<string, number | boolean>; evidenceIds: string[] }>;
  skipped: SkippedObservation[];
} {
  const facts: Array<{
    subjectId: string;
    kind: 'material';
    values: Record<string, number | boolean>;
    evidenceIds: string[];
  }> = [];
  const skipped: SkippedObservation[] = [];
  if (!projection) return { facts, skipped };

  for (const balance of projection.balances) {
    const subjectId = `material:${canonicalValue(balance.materialId)}`;
    if (balance.mixedUnits) {
      skipped.push({
        sensorId: balance.materialId,
        subjectId,
        field: 'inventory',
        reason: 'mixed_units',
        detail: '同物料存在多种计量单位：无法合并数量（需先在主数据统一单位）',
      });
      continue;
    }
    if (balance.minThreshold === null) {
      skipped.push({
        sensorId: balance.materialId,
        subjectId,
        field: 'inventory',
        reason: 'no_threshold',
        detail: '入库记录未声明再订货点（minThreshold）：没有阈值就不判定短缺',
      });
      continue;
    }
    facts.push({
      subjectId,
      kind: 'material',
      values: {
        inventory: balance.onHand,
        minThreshold: balance.minThreshold,
        // 账实不符信号随事实一起给引擎与现场（不影响规则判定，但必须可见）
        negativeOnHand: balance.negative,
      },
      // 证据必须是规范身份（`event:<id>`）：原始事件号直接塞进去会被推理契约 fail-closed 拒绝
      evidenceIds: balance.evidenceIds.slice(0, 20).map((id) => `event:${canonicalValue(id)}`),
    });
  }
  return { facts, skipped };
}

/* ── 物料需求（订单 BOM）与缺口影响面 ──────────────────────────────────────
 *
 * 光有"库存低于再订货点"还不足以让现场行动——班组长要问的是"这会影响哪些订单、
 * 还差多少"。需求来自 ERP 订单事件里的 BOM，但 **BOM 数量的口径必须显式声明**：
 * 是"每件产品的用量"还是"整单用量"？两者相差一个订单数量，猜错就是几倍的缺口。
 * 因此：
 *   · 新订单必须声明 `bomBasis`（per_unit / per_order）；
 *   · 未声明口径的历史订单 → **不参与需求计算**，单独列出（"无法计算需求"），
 *     而不是按某个默认值算出一个看起来很确定的错误数字。
 */

export const BOM_BASES = ['per_unit', 'per_order'] as const;
export type BomBasis = (typeof BOM_BASES)[number];

export function isBomBasis(value: unknown): value is BomBasis {
  return (BOM_BASES as readonly string[]).includes(String(value ?? ''));
}

export interface OrderBomLine {
  materialId: string;
  /** 按 `basis` 解释的用量。 */
  quantity: number;
  /** BOM 行声明的单位（可选；与库存单位不一致时**不做比较**，见 NO-29b）。 */
  unit?: string | null;
}

export interface MaterialDemandOrderInput {
  eventId: string;
  externalOrderId: string;
  /** 订单数量（件）。 */
  quantity: number;
  bom: OrderBomLine[];
  /** 计划完工时间（ISO；缺失 → null，不猜）。 */
  dueAt: string | null;
  /** BOM 口径；缺失 = 历史数据，无法计算需求。 */
  basis: BomBasis | null;
}

export interface MaterialDemand {
  materialId: string;
  /** 未完工订单对它的需求合计（按声明口径换算）。 */
  requiredQuantity: number;
  unit: string | null;
  /** BOM 行出现过的单位（去重）——用于与库存单位对齐校验。 */
  bomUnits: string[];
  orders: Array<{
    externalOrderId: string;
    eventId: string;
    requiredQuantity: number;
    orderQuantity: number;
    dueAt: string | null;
  }>;
  evidenceIds: string[];
  /** 是否含逾期未完工订单（逾期需求更要紧）。 */
  hasOverdue: boolean;
}

export interface MaterialDemandProjection {
  demands: MaterialDemand[];
  /** 口径未声明的历史订单（**不参与计算**，如实列出）。 */
  unknownBasisOrders: Array<{ eventId: string; externalOrderId: string; reason: string }>;
  /** 形状不合法（既有 bom 但数量非法等）的订单。 */
  invalidOrders: Array<{ eventId: string; externalOrderId: string; reason: string }>;
  generatedAt: string;
}

/**
 * 把"未完工的 ERP 订单"投影成物料需求。
 *
 * 入参应只包含**未完工**订单（调用方按状态过滤）；这里不再做状态判断，
 * 避免两处口径。所有跳过都有原因，且不会因为一条脏数据丢掉整批。
 */
export function projectMaterialDemand(
  orders: readonly MaterialDemandOrderInput[],
  options: { nowMs?: number } = {},
): MaterialDemandProjection {
  const nowMs = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const byMaterial = new Map<string, MaterialDemand>();
  const unknownBasisOrders: MaterialDemandProjection['unknownBasisOrders'] = [];
  const invalidOrders: MaterialDemandProjection['invalidOrders'] = [];

  for (const order of orders) {
    if (!order.basis) {
      unknownBasisOrders.push({
        eventId: order.eventId,
        externalOrderId: order.externalOrderId,
        reason: 'bom_basis_undeclared（未声明每件用量还是整单用量：不按猜测计算需求）',
      });
      continue;
    }
    if (!Number.isFinite(order.quantity) || order.quantity <= 0) {
      invalidOrders.push({
        eventId: order.eventId,
        externalOrderId: order.externalOrderId,
        reason: `订单数量非法（${String(order.quantity)}）`,
      });
      continue;
    }
    if (!Array.isArray(order.bom) || order.bom.length === 0) continue;
    const overdue = order.dueAt !== null && Date.parse(order.dueAt) < nowMs;
    for (const line of order.bom) {
      const materialId = String(line?.materialId ?? '').trim();
      const perBasis = Number(line?.quantity);
      if (!materialId || !Number.isFinite(perBasis) || perBasis <= 0) {
        invalidOrders.push({
          eventId: order.eventId,
          externalOrderId: order.externalOrderId,
          reason: `BOM 行非法（materialId=${materialId || '空'} quantity=${String(line?.quantity)}）`,
        });
        continue;
      }
      const required = order.basis === 'per_unit' ? perBasis * order.quantity : perBasis;
      const bomUnit = typeof line?.unit === 'string' && line.unit.trim() !== '' ? line.unit.trim() : null;
      let demand = byMaterial.get(materialId);
      if (!demand) {
        demand = {
          materialId,
          requiredQuantity: 0,
          unit: null,
          bomUnits: [],
          orders: [],
          evidenceIds: [],
          hasOverdue: false,
        };
        byMaterial.set(materialId, demand);
      }
      demand.requiredQuantity = Number((demand.requiredQuantity + required).toFixed(6));
      demand.orders.push({
        externalOrderId: order.externalOrderId,
        eventId: order.eventId,
        requiredQuantity: Number(required.toFixed(6)),
        orderQuantity: order.quantity,
        dueAt: order.dueAt,
      });
      demand.evidenceIds.push(order.eventId);
      if (bomUnit && !demand.bomUnits.includes(bomUnit)) demand.bomUnits.push(bomUnit);
      if (demand.bomUnits.length === 1) demand.unit = demand.bomUnits[0];
      else demand.unit = null;
      if (overdue) demand.hasOverdue = true;
    }
  }

  return {
    demands: [...byMaterial.values()].sort((a, b) => a.materialId.localeCompare(b.materialId)),
    unknownBasisOrders,
    invalidOrders,
    generatedAt,
  };
}

export type MaterialStockStatus =
  | 'ok'
  | 'below_threshold'
  | 'below_demand'
  | 'no_threshold'
  | 'mixed_units'
  | 'no_movements'
  | 'unit_mismatch';

export interface MaterialImpactRow {
  materialId: string;
  onHand: number | null;
  unit: string | null;
  minThreshold: number | null;
  requiredQuantity: number | null;
  /** 相对再订货点的缺口（>0 = 低于阈值多少）。 */
  thresholdGap: number | null;
  /** 相对未完工需求的缺口（>0 = 还差多少）。 */
  demandGap: number | null;
  status: MaterialStockStatus;
  statusLabel: string;
  /** 影响面：受影响的未完工订单（可追溯）。 */
  affectedOrders: Array<{ externalOrderId: string; requiredQuantity: number; dueAt: string | null }>;
  hasOverdue: boolean;
  evidenceIds: string[];
}

const STATUS_LABELS: Record<MaterialStockStatus, string> = {
  ok: '正常',
  below_threshold: '低于再订货点',
  below_demand: '不足以覆盖未完工订单',
  no_threshold: '未声明再订货点（不判定短缺）',
  mixed_units: '计量单位不一致（无法合并）',
  no_movements: '只有需求、没有出入库记录（库存未知）',
  unit_mismatch: '库存与 BOM 计量单位不一致（无法比较）',
};

/**
 * 合并"库存"与"需求"，给出**可行动的缺口结论**。
 *
 * 优先级：单位不一致 → 无法判定；只有需求没有库存记录 → 库存未知（不是 0）；
 * 需求缺口 > 0 → 不足以覆盖订单（比"低于再订货点"更紧迫）；否则看阈值。
 */
export function buildMaterialImpact(
  inventory: MaterialInventoryProjection | null,
  demand: MaterialDemandProjection | null,
): MaterialImpactRow[] {
  const balances = new Map((inventory?.balances ?? []).map((b) => [b.materialId, b]));
  const demands = new Map((demand?.demands ?? []).map((d) => [d.materialId, d]));
  const materialIds = [...new Set([...balances.keys(), ...demands.keys()])].sort();

  return materialIds.map((materialId) => {
    const balance = balances.get(materialId) ?? null;
    const need = demands.get(materialId) ?? null;
    const onHand = balance ? balance.onHand : null;
    const requiredQuantity = need ? need.requiredQuantity : null;
    const mixedUnits = balance?.mixedUnits === true;
    // 单位不一致：库存单位 vs BOM 单位（或 BOM 自身多种单位）→ **不比较**
    //（把 15 kg 与 60 件相比得出的"缺口"是编造，不是计算）
    const bomUnits = need?.bomUnits ?? [];
    const unitMismatch =
      balance?.unit !== null &&
      balance?.unit !== undefined &&
      bomUnits.length > 0 &&
      (bomUnits.length > 1 || bomUnits[0] !== balance.unit);
    let status: MaterialStockStatus;
    if (mixedUnits) status = 'mixed_units';
    else if (unitMismatch) status = 'unit_mismatch';
    else if (onHand === null) status = 'no_movements';
    else if (requiredQuantity !== null && requiredQuantity > onHand) status = 'below_demand';
    else if (balance?.minThreshold !== null && balance?.minThreshold !== undefined && onHand < balance.minThreshold) {
      status = 'below_threshold';
    } else if (balance?.minThreshold === null || balance?.minThreshold === undefined) {
      status = 'no_threshold';
    } else status = 'ok';

    return {
      materialId,
      onHand,
      unit: balance?.unit ?? null,
      minThreshold: balance?.minThreshold ?? null,
      requiredQuantity,
      thresholdGap:
        balance?.minThreshold !== null && balance?.minThreshold !== undefined && onHand !== null
          ? Number((balance.minThreshold - onHand).toFixed(6))
          : null,
      demandGap:
        requiredQuantity !== null && onHand !== null
          ? Number((requiredQuantity - onHand).toFixed(6))
          : null,
      status,
      statusLabel: STATUS_LABELS[status],
      affectedOrders: need
        ? need.orders.map((order) => ({
            externalOrderId: order.externalOrderId,
            requiredQuantity: order.requiredQuantity,
            dueAt: order.dueAt,
          }))
        : [],
      hasOverdue: need?.hasOverdue ?? false,
      evidenceIds: [...(balance?.evidenceIds ?? []), ...(need?.evidenceIds ?? [])],
    };
  });
}
