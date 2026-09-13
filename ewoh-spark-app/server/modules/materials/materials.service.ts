import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ewohEvent, ewohMaterial, ewohMaterialRequirement, ewohScheduleTask, ewohScheduleTaskStep } from '@server/database/schema';
import { OPEN_ORDER_STATUSES as OPEN_ORDER_STATUSES_SHARED, countOpenSteps } from '@shared/order-chain';
import type { OrgContext } from '../shared/org-context.interceptor';
import type { WorldSnapshotMaterial, WorldSnapshotOrder } from '@shared/scheduler';
import {
  MATERIAL_MOVEMENT_TYPES,
  buildMaterialImpact,
  isBomBasis,
  isMaterialMovementType,
  projectMaterialDemand,
  projectMaterialInventory,
  type BomBasis,
  type MaterialBalance,
  type MaterialDemand,
  type MaterialDemandProjection,
  type MaterialImpactRow,
  type MaterialInventoryProjection,
} from '@shared/material-inventory';

export interface SnapshotFacts {
  materials: import('@shared/scheduler').WorldSnapshotMaterial[];
  materialsNote: string | null;
  orders: import('@shared/scheduler').WorldSnapshotOrder[];
  ordersNote: string | null;
}

const ERP_OUTBOUND = 'ERP_OUTBOUND';
const ERP_ORDER = 'ERP_ORDER';
/** 视为"未完工"的订单状态（其余状态不计入物料需求）。 */
// 未完工订单词表来自共享契约（与订单链消费面同一口径）。
const OPEN_ORDER_STATUSES = new Set<string>(OPEN_ORDER_STATUSES_SHARED);
/**
 * 订单扫描窗口（有界，避免长期运行后把全部订单读进内存）。
 *
 * ⚠️ 与库存不同：库存已改为**数据库侧全量聚合**（不受窗口影响），而订单需求仍需
 * 逐单读 BOM；因此这里保留窗口，但**必须把"是否触顶"如实回报**（见 `ordersTruncated`），
 * 否则又是一个隐形截断（原则 7）。
 */
const ORDER_SCAN_LIMIT = 2000;

/**
 * 一等实体扫描上限（P4/R-2，standalone_099）。
 *
 * 与订单窗口同款纪律：触顶必须显式回报（`ordersTruncated`），不静默截断——
 * 一张被悄悄丢掉的物料主数据/需求行，等于现场少看见一个缺口。
 */
const ENTITY_SCAN_LIMIT = 2000;

/** 一等实体原始库存事实行（raw SQL 退出，字段名即列名）。 */
interface MaterialStockFactRow {
  material_id: string | null;
  location_id: string | null;
  stock_id: string | null;
  quantity_status: string | null;
  /** postgres.js 下 numeric 默认以字符串返回，故兼容 number。 */
  quantity: string | number | null;
  unit: string | null;
  observed_at: string | Date | null;
  source_kind: string | null;
  source_ref: string | null;
}

/** 一等实体读面（物料主数据 + 库存事实 + 需求/阈值）。 */
interface MaterialEntityFacts {
  materials: Array<{
    materialId: string;
    materialCode: string;
    name: string;
    unit: string | null;
    category: string | null;
    status: string;
  }>;
  stocks: MaterialStockFactRow[];
  requirements: Array<{
    requirementId: string;
    materialId: string;
    requirementType: string;
    quantityStatus: string;
    quantity: string | null;
    unit: string | null;
    sourceKind: string;
    sourceRef: string | null;
    dueAt: Date | null;
    effectiveAt: Date;
    status: string;
  }>;
}

/** `/api/materials/inventory` 的响应形状（事件投影与实体读面共用，前端兼容）。 */
export interface MaterialInventoryView extends MaterialInventoryProjection {
  scannedEvents: number;
  movementEvents: number;
  impact: MaterialImpactRow[];
  demand: MaterialDemandProjection;
  scannedOrders: number;
  /** 库存是否覆盖全部事实（false = 只覆盖了部分，必须让现场看见）。 */
  aggregationComplete: boolean;
  aggregationNote: string;
  /** 需求是否触到扫描上限（true = 需求可能不完整，必须让现场看见）。 */
  ordersTruncated: boolean;
}

/** 实体投影结果：读面 + "显式声明读不到"的物料集合（合并裁决的输入，见下）。 */
interface EntityProjectionResult {
  view: MaterialInventoryView;
  /** 有 stock 行但 quantity_status='unknown' 的物料（positive unknown）。
   *  与"实体没有该物料的任何库存事实（对库存没有表态）"是两回事——合并时只有
   *  前者压过事件数字，后者必须让事件侧的已知库存照常出现。 */
  unknownMaterialIds: Set<string>;
}

/**
 * 实体库存事实的数量解析（"positive unknown"的唯一判定源）。
 *
 * quantity_status != 'known'，或数量缺失/非法 → known=false（读不到）——DB CHECK
 * 已保证 unknown 行的 quantity 必为 NULL，这里是同一不变量的读侧镜像（single
 * source：投影与合并裁决必须用同一判定，否则"谁压过谁"会漂移）。
 */
function parseStockQuantity(row: MaterialStockFactRow): { known: boolean; qty: number | null } {
  const status = String(row.quantity_status ?? '').toLowerCase();
  const qty = row.quantity === null || row.quantity === undefined ? null : Number(row.quantity);
  const known = status === 'known' && qty !== null && Number.isFinite(qty);
  return { known, qty: known ? qty : null };
}

/**
 * 物料库存读面（NO-27a）。
 *
 * 库存**不是**新台账，而是从权威事实（ERP 出站事件里的物料流动）投影出来的：
 * 入库累加、领用累减。这样做的代价是"事件被删/被改则库存失真"——但它换来的
 * 是**没有第二事实源**：现场看到的库存永远能追到具体单据（evidenceIds）。
 *
 * 历史自由格式载荷（没有物料字段）会被显式列为 `unparsable`，而不是被当成 0 数量
 * 悄悄参与投影（原则 7）。
 */
@Injectable()
export class MaterialsService {
  private readonly logger = new Logger(MaterialsService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：物料库存查询必须带租户上下文');
    }
    return orgId;
  }

  /**
   * 库存 + 需求 + 缺口影响面（NO-27a/28a）。
   *
   * 需求来自**未完工的 ERP 订单 BOM**：没有需求，现场看到"低于再订货点"也不知道
   * 该先补哪个料；没有库存，需求也只是纸面数字。两者合起来才是可行动结论，
   * 且每一行都给出订单号与事件 id（可追溯）。
   */
  async getInventory(actor?: OrgContext): Promise<MaterialInventoryView> {
    const orgId = this.requireOrgId(actor);
    const entityFacts = await this.readMaterialEntities(orgId);
    // 事件投影**永远计算**（2026-09-13 修复，e2e:materials 实测暴露）：
    // 此前"实体表有行 → 整体早返回"——种子里只要有任意一条物料主数据，
    // 全租户的 ERP 事件投影就被整体跳过，**只经由事件上报的物料从读面上消失**
    // （现场表现为：库存/缺口全部查无此料）。两套数据源的 correctly 语义是
    // **按物料合并**：一等实体是它所覆盖物料的权威；事件-only 的物料（历史
    // 集成、未建主数据的料）继续走事件投影。实体为空 → 行为与数字完全不变。
    const eventView = await this.projectInventoryFromEvents(orgId);
    if (
      entityFacts.materials.length === 0
      && entityFacts.stocks.length === 0
      && entityFacts.requirements.length === 0
    ) {
      return eventView;
    }
    const entityProjection = this.projectInventoryFromEntities(entityFacts);
    return this.mergeInventoryViews(eventView, entityProjection.view, entityProjection.unknownMaterialIds);
  }

  /**
   * 事件投影与实体投影的**按物料合并**。
   *
   * 冲突裁决：同一 materialId 两边都有 → **一等实体赢**（它是显式登记的
   * 主数据/库存事实；事件流动属于"未建主数据时的投影"）。事件-only 的物料
   * 原样保留——合并绝不能让任何一边的物料消失（那正是本次修的缺陷）。
   * "无法解析"清单取并集：两边读不到的事实都必须可见。
   *
   * @param entityUnknownStockIds 实体**显式声明读不到**库存的物料（有 stock 行
   *   但 quantity_status != known，DB CHECK 保证此时 quantity 为 NULL）。只有
   *   这种"positive unknown"才压过事件数字——"实体对该物料没有任何库存事实"
   *   不是表态，事件侧的已知库存必须保留（合并只让权威压过数字，绝不把已知
   *   事实伪造成未知；见回归「实体只覆盖需求时事件库存数字不得被抹成未知」）。
   */
  private mergeInventoryViews(
    eventView: MaterialInventoryView,
    entityView: MaterialInventoryView,
    entityUnknownStockIds: ReadonlySet<string>,
  ): MaterialInventoryView {
    // 实体"库存读不到"的物料：实体赢到底——不只实体没有 balance，
    // 事件投影算出的数字也必须让位（未知 ≠ 任何数字；一边说读不到、一边给个
    // 数，现场只会信那个数）。
    const balanceById = new Map(
      eventView.balances
        .filter((b) => !entityUnknownStockIds.has(b.materialId))
        .map((b) => [b.materialId, b]),
    );
    for (const b of entityView.balances) balanceById.set(b.materialId, b);
    const balances = [...balanceById.values()].sort((a, b) => a.materialId.localeCompare(b.materialId));

    const demandById = new Map(eventView.demand.demands.map((d) => [d.materialId, d]));
    for (const d of entityView.demand.demands) demandById.set(d.materialId, d);
    const demand: MaterialDemandProjection = {
      demands: [...demandById.values()].sort((a, b) => a.materialId.localeCompare(b.materialId)),
      unknownBasisOrders: [
        ...eventView.demand.unknownBasisOrders,
        ...entityView.demand.unknownBasisOrders,
      ],
      invalidOrders: [...eventView.demand.invalidOrders, ...entityView.demand.invalidOrders],
      generatedAt: entityView.demand.generatedAt,
    };

    const unparsable = [...eventView.unparsable, ...entityView.unparsable];
    const projection: MaterialInventoryProjection = {
      balances,
      unparsable,
      generatedAt: entityView.generatedAt,
    };
    const impact = buildMaterialImpact(projection, demand);
    // 实体的"库存未知"显式行不走 balances（未知 ≠ 0），重算 impact 会丢——
    // 从实体 impact 搬运未被覆盖的未知行，让"读不到"继续可见。
    const covered = new Set(impact.map((row) => row.materialId));
    for (const row of entityView.impact) {
      if (row.onHand === null && !covered.has(row.materialId)) impact.push(row);
    }
    impact.sort((a, b) => a.materialId.localeCompare(b.materialId));

    return {
      ...projection,
      scannedEvents: eventView.scannedEvents + entityView.scannedEvents,
      movementEvents: eventView.movementEvents + entityView.movementEvents,
      impact,
      demand,
      scannedOrders: eventView.scannedOrders + entityView.scannedOrders,
      ordersTruncated: eventView.ordersTruncated || entityView.ordersTruncated,
      aggregationComplete: eventView.aggregationComplete && entityView.aggregationComplete,
      aggregationNote:
        '物料口径：库存按物料合并两个来源——一等实体（ewoh_material_*，同料覆盖事件投影）'
        + '与 ERP 事件投影（ewoh_event，未建主数据的料，对**全部历史**流动做精确聚合，'
        + '不在内存里截断窗口）；任何一边的物料都不会因此消失。'
        + (eventView.ordersTruncated || entityView.ordersTruncated
          ? '注意：订单/实体扫描触顶，结果可能不完整，请核对。'
          : ''),
    };
  }

  /**
   * 事件投影（ewoh_event 的 ERP 流动 → 库存/需求/缺口）。
   *
   * 需求来自**未完工的 ERP 订单 BOM**：没有需求，现场看到"低于再订货点"也不知道
   * 该先补哪个料；没有库存，需求也只是纸面数字。两者合起来才是可行动结论，
   * 且每一行都给出订单号与事件 id（可追溯）。
   */
  private async projectInventoryFromEvents(orgId: string): Promise<MaterialInventoryView> {
    // ── 库存：**在数据库里按物料聚合全部历史流动**（NO-29a）──────────────────
    // 此前是"取最近 2000 条事件在内存里投影"：超过窗口的出入库会被**静默丢掉**，
    // 库存偏大或偏小都可能，而现场只看到一个确定数字（原则 7 的红线）。
    // 现在改为 SQL 精确聚合（sum/count/array_agg），窗口问题从根上消失；
    // 证据保留每物料最近 20 条事件 id（够追溯，不把整段历史搬进内存）。
    const movementRows = (await this.db.execute(sql`
      SELECT
        evidence_json->'materialMovement'->>'materialId' AS material_id,
        sum(
          CASE WHEN evidence_json->>'type' = 'inventory_receipt'
               THEN (evidence_json->'materialMovement'->>'quantity')::numeric
               ELSE -(evidence_json->'materialMovement'->>'quantity')::numeric END
        ) AS on_hand,
        count(*) AS movement_count,
        count(*) FILTER (WHERE evidence_json->>'type' = 'inventory_receipt') AS receipts,
        count(*) FILTER (WHERE evidence_json->>'type' = 'material_consumption') AS consumptions,
        array_agg(DISTINCT NULLIF(evidence_json->'materialMovement'->>'unit', '')) AS units,
        max(created_at) AS last_movement_at,
        (array_agg(
           NULLIF(evidence_json->'materialMovement'->>'minThreshold', '')::numeric
           ORDER BY created_at DESC
         ) FILTER (WHERE NULLIF(evidence_json->'materialMovement'->>'minThreshold', '') IS NOT NULL))[1] AS min_threshold,
        (array_agg(created_at ORDER BY created_at DESC)
         FILTER (WHERE NULLIF(evidence_json->'materialMovement'->>'minThreshold', '') IS NOT NULL))[1] AS threshold_declared_at,
        (array_agg(event_id ORDER BY created_at DESC))[1:20] AS evidence_ids
      FROM "ewoh_event"
      WHERE org_id = ${orgId}
        AND event_code = ${ERP_OUTBOUND}
        AND evidence_json->'materialMovement'->>'materialId' IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `)) as unknown as Array<Record<string, unknown>>;

    const unparsableRows = (await this.db.execute(sql`
      SELECT event_id, evidence_json->>'type' AS outbound_type, evidence_json->>'materialMovementParse' AS parse_state
      FROM "ewoh_event"
      WHERE org_id = ${orgId}
        AND event_code = ${ERP_OUTBOUND}
        AND evidence_json->>'type' IN ('inventory_receipt', 'material_consumption')
        AND evidence_json->'materialMovement'->>'materialId' IS NULL
      ORDER BY created_at DESC
      LIMIT 200
    `)) as unknown as Array<Record<string, unknown>>;

    const balances: MaterialBalance[] = movementRows.map((row) => {
      const units = Array.isArray(row.units)
        ? (row.units as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim() !== '')
        : [];
      const onHand = Number(row.on_hand ?? 0);
      const minThreshold =
        row.min_threshold === null || row.min_threshold === undefined ? null : Number(row.min_threshold);
      return {
        materialId: String(row.material_id),
        onHand: Number.isFinite(onHand) ? Number(onHand.toFixed(6)) : 0,
        unit: units.length === 1 ? units[0] : null,
        minThreshold: minThreshold !== null && Number.isFinite(minThreshold) ? minThreshold : null,
        thresholdDeclaredAt:
          row.threshold_declared_at instanceof Date
            ? row.threshold_declared_at.toISOString()
            : row.threshold_declared_at
              ? String(row.threshold_declared_at)
              : null,
        receipts: Number(row.receipts ?? 0),
        consumptions: Number(row.consumptions ?? 0),
        movementCount: Number(row.movement_count ?? 0),
        lastMovementAt:
          row.last_movement_at instanceof Date
            ? row.last_movement_at.toISOString()
            : String(row.last_movement_at ?? new Date().toISOString()),
        negative: onHand < 0,
        mixedUnits: units.length > 1,
        evidenceIds: Array.isArray(row.evidence_ids) ? (row.evidence_ids as string[]) : [],
      };
    });

    const projection: MaterialInventoryProjection = {
      balances,
      unparsable: unparsableRows.map((row) => ({
        eventId: String(row.event_id),
        type: String(row.outbound_type ?? ''),
        reason:
          String(row.parse_state ?? '') === 'legacy'
            ? 'legacy_untyped_payload（历史自由格式：没有物料字段，无法参与库存投影）'
            : 'missing_normalized_movement',
      })),
      generatedAt: new Date().toISOString(),
    };

    // ── 需求：未完工 ERP 订单的 BOM（口径未声明的不参与计算）────────────────
    const orderRows = await this.db
      .select({
        eventId: ewohEvent.eventId,
        status: ewohEvent.status,
        createdAt: ewohEvent.createdAt,
        evidenceJson: ewohEvent.evidenceJson,
      })
      .from(ewohEvent)
      .where(and(eq(ewohEvent.orgId, orgId), eq(ewohEvent.eventCode, ERP_ORDER)))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(ORDER_SCAN_LIMIT);

    const openOrders = orderRows
      .filter((row) => OPEN_ORDER_STATUSES.has(String(row.status ?? '').toLowerCase()))
      .map((row) => {
        const evidence = (row.evidenceJson ?? {}) as Record<string, unknown>;
        const dueRaw = evidence.dueDate;
        const dueAt =
          typeof dueRaw === 'string' && dueRaw.trim() !== '' && Number.isFinite(Date.parse(dueRaw))
            ? new Date(dueRaw).toISOString()
            : null;
        return {
          eventId: String(row.eventId),
          externalOrderId: String(evidence.externalOrderId ?? row.eventId),
          quantity: Number(evidence.quantity ?? 0),
          bom: Array.isArray(evidence.bom)
            ? (evidence.bom as Array<{ materialId?: unknown; quantity?: unknown; unit?: unknown }>).map((line) => ({
                materialId: String(line?.materialId ?? ''),
                quantity: Number(line?.quantity ?? Number.NaN),
                unit: typeof line?.unit === 'string' && line.unit.trim() !== '' ? line.unit.trim() : null,
              }))
            : [],
          dueAt,
          basis: isBomBasis(evidence.bomBasis) ? (evidence.bomBasis as BomBasis) : null,
        };
      });

    const demand = projectMaterialDemand(openOrders);
    const movementEvents = balances.reduce((sum, balance) => sum + balance.movementCount, 0);
    return {
      ...projection,
      scannedEvents: movementEvents + projection.unparsable.length,
      movementEvents,
      impact: buildMaterialImpact(projection, demand),
      demand,
      scannedOrders: orderRows.length,
      ordersTruncated: orderRows.length >= ORDER_SCAN_LIMIT,
      aggregationComplete: true,
      aggregationNote:
        '库存在数据库侧对**全部历史**物料流动做精确聚合（不在内存里截断窗口）；' +
        '证据保留每物料最近 20 条事件 id。' +
        (orderRows.length >= ORDER_SCAN_LIMIT
          ? `订单需求只扫描了最近 ${ORDER_SCAN_LIMIT} 条订单（可能不完整，请核对）。`
          : ''),
    };
  }

  /**
   * 读取物料一等实体（P4/R-2，standalone_099）。
   *
   * 一次读完三张表：主数据、库存事实（每 (物料,库位) 取最新一条）、需求/阈值（open）。
   */
  private async readMaterialEntities(orgId: string): Promise<MaterialEntityFacts> {
    const materials = await this.db
      .select({
        materialId: ewohMaterial.materialId,
        materialCode: ewohMaterial.materialCode,
        name: ewohMaterial.name,
        unit: ewohMaterial.unit,
        category: ewohMaterial.category,
        status: ewohMaterial.status,
      })
      .from(ewohMaterial)
      .where(eq(ewohMaterial.orgId, orgId))
      .limit(ENTITY_SCAN_LIMIT);

    // 每 (物料, 库位) 取 observed_at 最新的一条：**当前库存** = 各库位最新值之和。
    // 用 DISTINCT ON 而不是对全表求和——同一库位的历史事实重复计量是另一种
    // 意义上的伪造（把"曾经有过"当成"现在有"）。
    const stocks = (await this.db.execute(sql`
      SELECT DISTINCT ON (material_id, location_id)
        material_id, location_id, stock_id, quantity_status, quantity, unit,
        observed_at, source_kind, source_ref
      FROM "ewoh_material_stock"
      WHERE org_id = ${orgId}
      ORDER BY material_id, location_id, observed_at DESC, stock_id DESC
    `)) as unknown as MaterialStockFactRow[];

    const requirements = await this.db
      .select({
        requirementId: ewohMaterialRequirement.requirementId,
        materialId: ewohMaterialRequirement.materialId,
        requirementType: ewohMaterialRequirement.requirementType,
        quantityStatus: ewohMaterialRequirement.quantityStatus,
        quantity: ewohMaterialRequirement.quantity,
        unit: ewohMaterialRequirement.unit,
        sourceKind: ewohMaterialRequirement.sourceKind,
        sourceRef: ewohMaterialRequirement.sourceRef,
        dueAt: ewohMaterialRequirement.dueAt,
        effectiveAt: ewohMaterialRequirement.effectiveAt,
        status: ewohMaterialRequirement.status,
      })
      .from(ewohMaterialRequirement)
      .where(and(
        eq(ewohMaterialRequirement.orgId, orgId),
        eq(ewohMaterialRequirement.status, 'open'),
      ))
      .limit(ENTITY_SCAN_LIMIT);

    return { materials, stocks, requirements };
  }

  /**
   * 把一等实体投影成与事件投影**同形**的读面（前端 / 世界快照零改动）。
   *
   * 与事件投影的根本差别：`quantity_status='unknown'` 的行在 DB 层就不带数量
   * （CHECK 强制 quantity IS NULL），所以这里**没有任何数字**可以被 `?? 0`
   * 误当成 0——读不到就只能如实回报"未知"（onHand=null / unparsable 列表）。
   */
  private projectInventoryFromEntities(facts: MaterialEntityFacts): EntityProjectionResult {
    const generatedAt = new Date().toISOString();
    const unparsable: MaterialInventoryProjection['unparsable'] = [];
    // "显式读不到"的物料集合：合并裁决用它区分「实体说读不到」与「实体没说」。
    const unknownMaterialIds = new Set<string>();

    // ── 1) 库存聚合：每物料 = 各库位最新事实之和 ──
    const stockByMaterial = new Map<string, {
      onHand: number;
      units: Set<string>;
      evidenceIds: string[];
      receipts: number;
      consumptions: number;
      movementCount: number;
      lastMovementAt: string;
      /** 任一库位数量未知 → 整物料库存未知（不出 balance，onHand 走 null）。 */
      unknown: boolean;
    }>();
    for (const row of facts.stocks) {
      const materialId = String(row.material_id ?? '').trim();
      if (!materialId) continue;
      let agg = stockByMaterial.get(materialId);
      if (!agg) {
        agg = {
          onHand: 0, units: new Set<string>(), evidenceIds: [],
          receipts: 0, consumptions: 0, movementCount: 0,
          lastMovementAt: '', unknown: false,
        };
        stockByMaterial.set(materialId, agg);
      }
      agg.movementCount += 1;
      const observedAt = row.observed_at instanceof Date
        ? row.observed_at.toISOString()
        : row.observed_at ? String(row.observed_at) : '';
      if (observedAt > agg.lastMovementAt) agg.lastMovementAt = observedAt;

      const parsed = parseStockQuantity(row);
      if (!parsed.known) {
        // ★ 读不到：**绝不当 0**。整物料库存标记为未知——把已知的几个库位加起来
        //   冒充总量，是把"部分事实"当成"全部事实"（同样违反不伪造纪律）。
        agg.unknown = true;
        unknownMaterialIds.add(materialId);
        unparsable.push({
          eventId: String(row.stock_id ?? materialId),
          type: 'stock_quantity_unknown',
          reason: `库位 ${String(row.location_id ?? '')} 的库存数量读不到（未知 ≠ 0，不计入合计）`,
        });
        continue;
      }
      agg.onHand += parsed.qty;
      const unit = typeof row.unit === 'string' && row.unit.trim() !== '' ? row.unit.trim() : null;
      if (unit) agg.units.add(unit);
      if (row.stock_id) agg.evidenceIds.push(String(row.stock_id));
      const kind = String(row.source_kind ?? '');
      if (kind === 'erp_receipt') agg.receipts += 1;
      else if (kind === 'erp_consumption') agg.consumptions += 1;
    }

    // ── 2) 阈值（再订货点）：按 effective_at 取最新一条；unknown → null（不猜）──
    const thresholdByMaterial = new Map<string, { value: number | null; declaredAt: string | null }>();
    // ── 3) 需求：open 需求按物料合计 ──
    const demandByMaterial = new Map<string, {
      requiredQuantity: number;
      units: Set<string>;
      orders: MaterialDemand['orders'];
      evidenceIds: string[];
      hasOverdue: boolean;
    }>();
    const invalidOrders: MaterialDemandProjection['invalidOrders'] = [];
    const demandOrderRefs = new Set<string>();
    const nowMs = Date.now();
    for (const req of facts.requirements) {
      const materialId = String(req.materialId ?? '').trim();
      if (!materialId) continue;
      const known = String(req.quantityStatus ?? '').toLowerCase() === 'known';
      const qty = req.quantity === null || req.quantity === undefined ? null : Number(req.quantity);
      const effectiveAt = req.effectiveAt instanceof Date
        ? req.effectiveAt.toISOString()
        : String(req.effectiveAt ?? '');
      if (req.requirementType === 'threshold') {
        const prev = thresholdByMaterial.get(materialId);
        if (!prev || effectiveAt >= (prev.declaredAt ?? '')) {
          thresholdByMaterial.set(materialId, {
            value: known && qty !== null && Number.isFinite(qty) ? qty : null,
            declaredAt: effectiveAt || null,
          });
        }
        continue;
      }
      if (req.requirementType !== 'demand') continue;
      if (!known || qty === null || !Number.isFinite(qty)) {
        // 需求读不到 → **不按猜测计算**，显式列出（复用"未纳入需求计算的订单"面）。
        invalidOrders.push({
          eventId: String(req.requirementId ?? ''),
          externalOrderId: String(req.sourceRef ?? req.requirementId ?? ''),
          reason: '需求数量读不到（未知 ≠ 0：不纳入缺口计算）',
        });
        continue;
      }
      let demand = demandByMaterial.get(materialId);
      if (!demand) {
        demand = { requiredQuantity: 0, units: new Set<string>(), orders: [], evidenceIds: [], hasOverdue: false };
        demandByMaterial.set(materialId, demand);
      }
      const dueAt = req.dueAt instanceof Date ? req.dueAt.toISOString() : req.dueAt ? String(req.dueAt) : null;
      const externalOrderId = String(req.sourceRef ?? req.requirementId ?? '');
      demandOrderRefs.add(externalOrderId);
      demand.requiredQuantity = Number((demand.requiredQuantity + qty).toFixed(6));
      demand.orders.push({
        externalOrderId,
        eventId: String(req.requirementId ?? ''),
        requiredQuantity: Number(qty.toFixed(6)),
        // 实体需求行本身就是"整单用量"（BOM 已展开），没有单独的订单件数可填，
        // 故 orderQuantity 取本行需求量——不额外编造一个订单数量。
        orderQuantity: Number(qty.toFixed(6)),
        dueAt,
      });
      demand.evidenceIds.push(String(req.requirementId ?? ''));
      const unit = typeof req.unit === 'string' && req.unit.trim() !== '' ? req.unit.trim() : null;
      if (unit) demand.units.add(unit);
      if (dueAt !== null && Date.parse(dueAt) < nowMs) demand.hasOverdue = true;
    }

    // ── 4) 组装 balance / demand 投影（复用共享契约形状）──
    const balances: MaterialBalance[] = [];
    for (const [materialId, agg] of stockByMaterial) {
      const threshold = thresholdByMaterial.get(materialId);
      if (agg.unknown) {
        // 库存未知：不出 balance（否则就得给 onHand 一个数字，也就是伪造）。
        // 该物料若有需求/阈值，会以 onHand=null（"未知"）出现在 impact；若什么
        // 需求都没有，至少出现在 unparsable —— 读不到必须看得见，不能消失。
        continue;
      }
      const units = [...agg.units];
      balances.push({
        materialId,
        onHand: Number(agg.onHand.toFixed(6)),
        unit: units.length === 1 ? units[0] : null,
        minThreshold: threshold?.value ?? null,
        thresholdDeclaredAt: threshold?.declaredAt ?? null,
        receipts: agg.receipts,
        consumptions: agg.consumptions,
        movementCount: agg.movementCount,
        lastMovementAt: agg.lastMovementAt || generatedAt,
        negative: agg.onHand < 0,
        mixedUnits: units.length > 1,
        evidenceIds: agg.evidenceIds.slice(0, 20),
      });
    }
    balances.sort((a, b) => a.materialId.localeCompare(b.materialId));

    const demands: MaterialDemand[] = [...demandByMaterial.entries()]
      .map(([materialId, d]) => {
        const units = [...d.units];
        return {
          materialId,
          requiredQuantity: Number(d.requiredQuantity.toFixed(6)),
          unit: units.length === 1 ? units[0] : null,
          bomUnits: units,
          orders: d.orders,
          evidenceIds: d.evidenceIds,
          hasOverdue: d.hasOverdue,
        };
      })
      .sort((a, b) => a.materialId.localeCompare(b.materialId));

    const demandProjection: MaterialDemandProjection = {
      demands,
      // 一等实体的需求是**已展开**的行（不再有 BOM 口径问题），故无"口径未声明"订单。
      unknownBasisOrders: [],
      invalidOrders,
      generatedAt,
    };
    const projection: MaterialInventoryProjection = { balances, unparsable, generatedAt };

    const impact = buildMaterialImpact(projection, demandProjection);
    // 未知库存的物料若既没有 balance 又没有需求，不会出现在 impact 里——那就等于
    // 从"库存与缺口"表里**消失**（读不到变成看不见，仍是静默）。补一行
    // onHand=null 的显式未知行：status 沿用 no_movements（封闭词表里唯一
    // "库存未知"语义），标签直说原因（数量读不到，不代表 0）。
    const covered = new Set(impact.map((row) => row.materialId));
    for (const [materialId, agg] of stockByMaterial) {
      if (!agg.unknown || covered.has(materialId)) continue;
      const threshold = thresholdByMaterial.get(materialId);
      impact.push({
        materialId,
        onHand: null,
        unit: null,
        minThreshold: threshold?.value ?? null,
        requiredQuantity: null,
        thresholdGap: null,
        demandGap: null,
        status: 'no_movements',
        statusLabel: '库存未知（数量读不到，不代表 0）',
        affectedOrders: [],
        hasOverdue: false,
        evidenceIds: agg.evidenceIds,
      });
    }
    impact.sort((a, b) => a.materialId.localeCompare(b.materialId));

    const truncated =
      facts.materials.length >= ENTITY_SCAN_LIMIT
      || facts.stocks.length >= ENTITY_SCAN_LIMIT
      || facts.requirements.length >= ENTITY_SCAN_LIMIT;

    return {
      view: {
        ...projection,
        scannedEvents: facts.stocks.length + unparsable.length,
        movementEvents: facts.stocks.length,
        impact,
        demand: demandProjection,
        scannedOrders: demandOrderRefs.size,
        ordersTruncated: truncated,
        aggregationComplete: !truncated,
        aggregationNote:
          '物料口径：来自一等实体（ewoh_material / ewoh_material_stock / ewoh_material_requirement）；'
          + '库存 = 各库位最新事实之和，未知数量行不计入合计（未知 ≠ 0，见「无法解析」列表）。'
          + (truncated ? `实体扫描触顶（${ENTITY_SCAN_LIMIT} 行），结果可能不完整，请核对。` : ''),
      },
      unknownMaterialIds,
    };
  }

  /** 物料流动类型词表（可解释面：UI/对接方据此知道哪些 type 会被投影）。 */
  listMovementTypes(): readonly string[] {
    return MATERIAL_MOVEMENT_TYPES;
  }
  // ── 世界快照投影（DR-6，2026-09-11）────────────────────────────────────
  // 快照 collectState 高频调用：per-org 短 TTL 缓存（15s）限流聚合成本。
  // 缓存键含 orgId（租户隔离：绝无跨租户命中）；TTL 过期或异常即回源重算。
  private static readonly SNAPSHOT_FACTS_TTL_MS = 15_000;
  private readonly snapshotFactsCache = new Map<
    string,
    { at: number; value: SnapshotFacts }
  >();

  /** 世界快照扩展事实：物料缺口行 + 未完工订单（含口径说明，缺失不伪造）。 */
  async getSnapshotFacts(actor?: OrgContext): Promise<SnapshotFacts> {
    const orgId = this.requireOrgId(actor);
    const cached = this.snapshotFactsCache.get(orgId);
    if (cached && Date.now() - cached.at < MaterialsService.SNAPSHOT_FACTS_TTL_MS) {
      return cached.value;
    }
    const inventory = await this.getInventory(actor);
    // 缺口行（demandGap/thresholdGap>0 或 status=below_threshold/shortage）——
    // 全满足不出行（快照是决策面，不是台账全量镜像；台账明细在 /api/materials）。
    const materials: WorldSnapshotMaterial[] = inventory.impact
      .filter(
        (row) =>
          (row.demandGap ?? 0) > 0
          || (row.thresholdGap ?? 0) > 0
          || row.status === 'below_threshold'
          || row.status === 'below_demand',
      )
      .map((row) => ({
        materialId: row.materialId,
        name: null,
        unit: row.unit,
        onHand: row.onHand ?? 0,
        requiredTotal: row.requiredQuantity ?? 0,
        shortage: Math.max(row.demandGap ?? 0, row.thresholdGap ?? 0),
        orderNos: row.affectedOrders.map((o) => o.externalOrderId),
        minThreshold: row.minThreshold,
        belowThreshold:
          row.status === 'below_threshold' || (row.thresholdGap ?? 0) > 0,
      }));
    // 未完工订单：最近 50 条 open ERP_ORDER（轻量直查，不走全量需求聚合）。
    const orderRows = await this.db
      .select({
        eventId: ewohEvent.eventId,
        status: ewohEvent.status,
        evidenceJson: ewohEvent.evidenceJson,
      })
      .from(ewohEvent)
      .where(and(eq(ewohEvent.orgId, orgId), eq(ewohEvent.eventCode, ERP_ORDER)))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(200);
    const orderCandidates = orderRows
      .filter((r) => OPEN_ORDER_STATUSES.has(String(r.status ?? '').toLowerCase()))
      .map((r) => {
        const evidence = (r.evidenceJson ?? {}) as Record<string, unknown>;
        const dueRaw = evidence.dueDate;
        const dueAt =
          typeof dueRaw === 'string' && dueRaw.trim() !== '' && Number.isFinite(Date.parse(dueRaw))
            ? new Date(dueRaw).toISOString()
            : null;
        return {
          orderId: String(evidence.externalOrderId ?? r.eventId),
          orderNo: String(evidence.externalOrderId ?? r.eventId),
          status: 'open',
          priority: null,
          dueAt,
          remainingOperations: null as number | null,
          taskIds: [] as string[],
        };
      })
      .slice(0, 50);
    /**
     * NO-57a：把**订单 → 任务/工序**的链路真的填进去。
     *
     * 缺陷背景：这两个字段此前被写死（`taskIds: []`、`remainingOperations: null`），
     * 而 MES 建单时 `schedule_task_id = 订单号`、工序行也在 `ewoh_schedule_task_step` 里
     * ——链路一直存在，只是投影从没读它。结果所有消费方（解释/看板/受影响对象）
     * 都以为"订单没有任务"，把已有事实当成缺口。
     */
    let openOrders = orderCandidates;
    if (orderCandidates.length > 0) {
      try {
        const orderNos = orderCandidates.map((order) => order.orderNo);
        const taskRows = await this.db
          .select({
            taskId: ewohScheduleTask.scheduleTaskId,
            status: ewohScheduleTask.status,
          })
          .from(ewohScheduleTask)
          .where(and(eq(ewohScheduleTask.orgId, orgId), inArray(ewohScheduleTask.scheduleTaskId, orderNos)))
          .limit(200);
        const stepRows = taskRows.length === 0
          ? []
          : await this.db
            .select({
              scheduleTaskId: ewohScheduleTaskStep.scheduleTaskId,
              status: ewohScheduleTaskStep.status,
            })
            .from(ewohScheduleTaskStep)
            .where(and(
              eq(ewohScheduleTaskStep.orgId, orgId),
              inArray(ewohScheduleTaskStep.scheduleTaskId, taskRows.map((row) => row.taskId)),
            ))
            .limit(1000);
        const stepsByTask = new Map<string, Array<{ status: string | null }>>();
        for (const step of stepRows) {
          const taskId = String(step.scheduleTaskId ?? '');
          if (taskId === '') continue;
          const list = stepsByTask.get(taskId) ?? [];
          list.push({ status: step.status ?? null });
          stepsByTask.set(taskId, list);
        }
        const taskIdsByOrder = new Map(taskRows.map((row) => [row.taskId, row.taskId]));
        openOrders = orderCandidates.map((order) => {
          const taskId = taskIdsByOrder.get(order.orderNo) ?? null;
          if (!taskId) return order;
          const steps = stepsByTask.get(taskId) ?? [];
          return {
            ...order,
            taskIds: [taskId],
            remainingOperations: steps.length > 0 ? countOpenSteps(steps) : null,
          };
        });
      } catch (error) {
        // 链路补全失败 → 保持**显式缺口**（空数组/null），并留痕；绝不编造任务号。
        this.logger.warn(
          `订单→任务链路投影失败（保持显式缺口）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const value: SnapshotFacts = {
      materials,
      materialsNote:
        inventory.aggregationComplete && !inventory.ordersTruncated
          ? null
          : `物料口径：aggregationComplete=${String(inventory.aggregationComplete)}，ordersTruncated=${String(inventory.ordersTruncated)}（数字可能不完整）`,
      orders: openOrders,
      ordersNote: inventory.ordersTruncated
        ? `订单扫描触顶（${ORDER_SCAN_LIMIT} 单），订单列表可能不完整`
        : null,
    };
    this.snapshotFactsCache.set(orgId, { at: Date.now(), value });
    return value;
  }

}
