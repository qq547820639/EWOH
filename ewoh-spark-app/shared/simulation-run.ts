/* 前后端共享契约 - Canonical Simulation Run（ADR-025 / NO-12a，§13 Digital Twin Simulation）。
 *
 * 权威契约：contracts/simulation/simulation-run.schema.json +
 * simulation-run.test-vectors.json。
 * 语义与 src/edge_platform/contracts/simulation_run.py 逐项一致（Golden #19 共享向量约束）。
 */

export const SIMULATION_KINDS = ['what_if', 'capacity', 'layout', 'material_flow'] as const;
export const SIMULATION_STATUSES = ['created', 'running', 'completed', 'failed'] as const;

const KIND_SET: ReadonlySet<string> = new Set(SIMULATION_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(SIMULATION_STATUSES);

const REQUIRED_FIELDS = [
  'runId', 'kind', 'status', 'isSimulation', 'baseRef', 'parameters',
  'engineVersion', 'auditTrail',
] as const;

export interface SimulationBaseRef {
  snapshotVersion: number;
  scenarioId?: string;
}

export interface SimulationRunRecord {
  runId: string;
  kind: string;
  status: string;
  isSimulation: boolean;
  baseRef: SimulationBaseRef;
  parameters: Record<string, unknown>;
  results?: Record<string, unknown>;
  failureReason?: string;
  engineVersion: string;
  auditTrail: boolean;
}

/** 校验仿真运行记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateSimulationRun(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.runId !== 'string' || r.runId.trim() === '') return ['bad_run_id'];
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (r.isSimulation !== true) return ['isolation_required'];
  const baseRef = r.baseRef;
  if (baseRef == null || typeof baseRef !== 'object' || Array.isArray(baseRef)) {
    return ['bad_base_ref'];
  }
  const snapshot = (baseRef as Record<string, unknown>).snapshotVersion;
  if (typeof snapshot !== 'number' || !Number.isInteger(snapshot) || snapshot < 0) {
    return ['bad_base_ref'];
  }
  const scenarioId = (baseRef as Record<string, unknown>).scenarioId;
  if (scenarioId !== undefined && typeof scenarioId !== 'string') {
    return ['bad_base_ref'];
  }
  const parameters = r.parameters;
  if (parameters == null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return ['bad_parameters'];
  }
  if (r.status === 'completed') {
    const results = r.results;
    if (results == null || typeof results !== 'object' || Array.isArray(results)) {
      return ['results_required'];
    }
  }
  if (r.status === 'failed') {
    const reasonText = r.failureReason;
    if (typeof reasonText !== 'string' || reasonText.trim() === '') {
      return ['failure_reason_required'];
    }
  }
  if (typeof r.engineVersion !== 'string' || r.engineVersion.trim() === '') {
    return ['bad_engine_version'];
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}

// ---------------------------------------------------------------------------
// 确定性评估器（ADR-025 §评估器矩阵；与 Python simulation_run.py 逐项一致）
// ---------------------------------------------------------------------------

export interface WhatIfFact {
  ruleId: string;
  subjectId: string;
  conclusion: string;
  confidence: number;
}

export interface WhatIfConclusion extends WhatIfFact {}

export interface WhatIfResult {
  traceId: string;
  baseCount: number;
  scenarioCount: number;
  added: WhatIfConclusion[];
  removed: WhatIfConclusion[];
  changed: {
    ruleId: string;
    subjectId: string;
    conclusion: string;
    baseConfidence: number;
    scenarioConfidence: number;
  }[];
}

function collectConclusions(facts: unknown[]): Map<string, WhatIfConclusion> {
  const result = new Map<string, WhatIfConclusion>();
  for (const fact of facts) {
    if (fact == null || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new Error('fact 必须是对象');
    }
    const f = fact as Record<string, unknown>;
    const { ruleId, subjectId, conclusion, confidence } = f;
    if (typeof ruleId !== 'string' || typeof subjectId !== 'string' || typeof conclusion !== 'string') {
      throw new Error('fact 须含字符串 ruleId/subjectId/conclusion');
    }
    // R2-SHR-003：数值入口统一 Number.isFinite（NaN/±Inf 一律拒绝，与 Python isfinite 对齐）。
    if (typeof confidence === 'boolean' || typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      throw new Error('fact.confidence 必须是数值');
    }
    result.set(`${ruleId}\u0000${subjectId}\u0000${conclusion}`, {
      ruleId, subjectId, conclusion, confidence: Number(confidence),
    });
  }
  return result;
}

/** What-if 评估：对比 base 与 scenario（delta）推理结论的差集。 */
export function evaluateWhatIf(
  traceId: string,
  baseFacts: unknown[],
  deltaFacts: unknown[],
): WhatIfResult {
  if (!Array.isArray(baseFacts) || !Array.isArray(deltaFacts)) {
    throw new Error('baseFacts/deltaFacts 必须是列表');
  }
  const baseConcl = collectConclusions(baseFacts);
  const scenConcl = collectConclusions(deltaFacts);
  const sortedEntries = (keys: string[], concl: Map<string, WhatIfConclusion>) =>
    keys.sort().map((k) => concl.get(k)!);

  const addedKeys = [...scenConcl.keys()].filter((k) => !baseConcl.has(k));
  const removedKeys = [...baseConcl.keys()].filter((k) => !scenConcl.has(k));
  const added = sortedEntries(addedKeys, scenConcl);
  const removed = sortedEntries(removedKeys, baseConcl);
  const changed: WhatIfResult['changed'] = [];
  for (const key of [...baseConcl.keys()].filter((k) => scenConcl.has(k)).sort()) {
    const base = baseConcl.get(key)!;
    const scen = scenConcl.get(key)!;
    if (base.confidence !== scen.confidence) {
      changed.push({
        ruleId: base.ruleId,
        subjectId: base.subjectId,
        conclusion: base.conclusion,
        baseConfidence: base.confidence,
        scenarioConfidence: scen.confidence,
      });
    }
  }
  return {
    traceId,
    baseCount: baseConcl.size,
    scenarioCount: scenConcl.size,
    added,
    removed,
    changed,
  };
}

export interface CapacityResult {
  bottleneckStationId: string;
  lineThroughputPerHour: number;
  utilization: number;
  overloaded: boolean;
}

/** 容量评估：求瓶颈工位与线产能。公式与 Python 端一致。 */
export function evaluateCapacity(
  stations: unknown[],
  demandPerHour: number,
): CapacityResult {
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new Error('stations 必须是非空列表');
  }
  if (typeof demandPerHour !== 'number' || !Number.isFinite(demandPerHour) || demandPerHour <= 0) {
    throw new Error('demandPerHour 必须 > 0');
  }
  const normalized = stations.map((station) => {
    if (station == null || typeof station !== 'object' || Array.isArray(station)) {
      throw new Error('station 必须是对象');
    }
    const s = station as Record<string, unknown>;
    const stationId = s.stationId;
    const capacity = s.capacityPerHour;
    if (typeof stationId !== 'string' || stationId === '') {
      throw new Error('station.stationId 必须是非空字符串');
    }
    if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('station.capacityPerHour 必须 > 0');
    }
    return { stationId, capacityPerHour: capacity };
  });
  const lineThroughput = Math.min(...normalized.map((s) => s.capacityPerHour));
  // SH-017：显式判空替代 ! 非空断言（浮点精度下 find 可能失配，避免运行时 crash）。
  const bottleneck = normalized.find((s) => s.capacityPerHour === lineThroughput);
  if (bottleneck == null) {
    throw new Error('容量瓶颈工位解析失败（stations 不能为空）');
  }
  const utilization = Math.round((demandPerHour / lineThroughput) * 1e6) / 1e6;
  return {
    bottleneckStationId: bottleneck.stationId,
    lineThroughputPerHour: lineThroughput,
    utilization,
    overloaded: utilization > 1.0,
  };
}

export interface LayoutRoute {
  fromStationId: string;
  toStationId: string;
  distance: number;
  trips: number;
  totalDistance: number;
}

export interface LayoutResult {
  totalTravelDistance: number;
  routes: LayoutRoute[];
}

/** 布局评估：物料搬运总行程（欧氏距离 × 趟次），round6 保证跨语言一致。 */
export function evaluateLayout(stations: unknown[], moves: unknown[]): LayoutResult {
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new Error('stations 必须是非空列表');
  }
  if (!Array.isArray(moves)) throw new Error('moves 必须是列表');
  const coords = new Map<string, [number, number]>();
  for (const station of stations) {
    if (station == null || typeof station !== 'object' || Array.isArray(station)) {
      throw new Error('station 必须是对象');
    }
    const s = station as Record<string, unknown>;
    const { stationId, x, y } = s;
    if (typeof stationId !== 'string' || stationId === '') {
      throw new Error('station.stationId 必须是非空字符串');
    }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('station.x/y 必须是数值');
    }
    coords.set(stationId, [x, y]);
  }
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const routes: LayoutRoute[] = [];
  let total = 0;
  for (const move of moves) {
    if (move == null || typeof move !== 'object' || Array.isArray(move)) {
      throw new Error('move 必须是对象');
    }
    const m = move as Record<string, unknown>;
    const fromId = m.fromStationId;
    const toId = m.toStationId;
    const trips = m.trips;
    if (typeof fromId !== 'string' || typeof toId !== 'string' || !coords.has(fromId) || !coords.has(toId)) {
      throw new Error(`未知工位：${String(fromId)} / ${String(toId)}`);
    }
    if (typeof trips !== 'number' || !Number.isInteger(trips) || trips < 1) {
      throw new Error('move.trips 必须是 ≥1 整数');
    }
    const [x1, y1] = coords.get(fromId)!;
    const [x2, y2] = coords.get(toId)!;
    const distance = round6(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2));
    const weighted = round6(distance * trips);
    total = round6(total + weighted);
    routes.push({
      fromStationId: fromId,
      toStationId: toId,
      distance,
      trips,
      totalDistance: weighted,
    });
  }
  return { totalTravelDistance: total, routes };
}

export interface MaterialFlowStation {
  stationId: string;
  loadRatio: number;
  overloaded: boolean;
}

export interface MaterialFlowResult {
  bottleneckStationId: string;
  bottleneckLoadRatio: number;
  stations: MaterialFlowStation[];
}

/** 物料流评估：载荷比 = inflow / capacity；瓶颈 = 最大载荷比工位。 */
export function evaluateMaterialFlow(stations: unknown[]): MaterialFlowResult {
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new Error('stations 必须是非空列表');
  }
  const normalized = stations.map((station) => {
    if (station == null || typeof station !== 'object' || Array.isArray(station)) {
      throw new Error('station 必须是对象');
    }
    const s = station as Record<string, unknown>;
    const stationId = s.stationId;
    const capacity = s.capacityPerHour;
    const inflow = s.inflowPerHour;
    if (typeof stationId !== 'string' || stationId === '') {
      throw new Error('station.stationId 必须是非空字符串');
    }
    if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('station.capacityPerHour 必须 > 0');
    }
    if (typeof inflow !== 'number' || !Number.isFinite(inflow) || inflow < 0) {
      throw new Error('station.inflowPerHour 必须 ≥ 0');
    }
    const loadRatio = Math.round((inflow / capacity) * 1e6) / 1e6;
    return { stationId, loadRatio, overloaded: loadRatio > 1.0 };
  });
  const bottleneck = normalized.reduce((acc, s) => (s.loadRatio > acc.loadRatio ? s : acc));
  return {
    bottleneckStationId: bottleneck.stationId,
    bottleneckLoadRatio: bottleneck.loadRatio,
    stations: normalized,
  };
}
