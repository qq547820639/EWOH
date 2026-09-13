/* 观测事实投影（NO-25a）——把**已被感知到的事实**投影成 L4 推理事实。
 *
 * 为什么需要它：推理引擎（`shared/reasoning-trace.ts`，ADR-020）注册了
 * `rule:machine-vibration-risk` 等规则，但生产路径上**没有人供给事实**——
 * 规则只有手工 POST facts 才会触发。观测能力（`observe.vibration` 等）已经把
 * 读数写进 `ewoh_environment`，却没有任何地方把它变成"设备振动超标"这个事实。
 * 于是"感知"与"理解/预测"之间缺了一环；本文件补上这一环。
 *
 * 设计边界（原则 3/5/7/13）：
 *   · **只做确定性投影**，不做统计推断、不调用 LLM；每条事实都能追到一行读数；
 *   · **能力模型是权威**：设备未声明对应观测能力 → 不产出事实（并给出原因）；
 *   · **数据质量不合格不得成为事实**：读数过期/置信度过低 → 进 `skipped` 并写明原因，
 *     绝不"凑一个事实"（原则 7）；
 *   · 阈值是显式常量并随事实一起返回，现场能看到"为什么判定超标"（原则 5）。
 */

import type { WorldStateSnapshot } from './scheduler';
import type { ReasoningFact } from './reasoning-trace';

/**
 * 观测阈值默认值。
 *
 * `vibration`（mm/s RMS，速度有效值）：ISO 10816 对中小型机组（Class I/II）的
 * 划分——≤4.5 可长期运行，>7.1 属"不可接受/需尽快处置"。这里取 7.1 作为**超标**
 * 判定线（保守：不把 4.5~7.1 的"观察区"直接说成风险）。
 * 温度/噪声/空气质量当前**不产出**事实：本仓库没有与之匹配的已注册推理规则，
 * 凭空造一条"温度风险"规则会违反"只注册有确定性引擎的类型"（§33）。
 */
export const OBSERVATION_LIMITS = {
  /** 振动速度有效值超标线（mm/s）。 */
  vibrationMmPerSec: 7.1,
  /** 读数新鲜度窗口：超过则视为过期（不参与判定）。 */
  freshnessMs: 15 * 60 * 1000,
  /** 最低数据置信度：低于则不参与判定。 */
  minDataConfidence: 0.5,
} as const;

/** 一行环境读数（`ewoh_environment` 的投影，字段缺失即 null）。 */
export interface EnvironmentReadingInput {
  sensorId: string;
  entityId?: string | null;
  temperature?: number | null;
  vibration?: number | null;
  noise?: number | null;
  airQuality?: number | null;
  /** 观测时间（ISO）。 */
  ts: string;
  sourceType?: string | null;
  dataConfidence?: number | null;
}

/** 投影出的证据来源（供 UI/审计展示：来源、时间、数值、阈值、质量）。 */
export interface ObservationEvidence {
  /** 规范身份 `sensor:<sensorId>-<observedMs>`（kind 取自 identity 注册表）。 */
  evidenceId: string;
  subjectId: string;
  capability: string;
  field: 'vibration';
  value: number;
  threshold: number;
  unit: string;
  observedAt: string;
  ageMs: number;
  dataQuality: 'FRESH' | 'STALE' | 'UNKNOWN';
  dataConfidence: number | null;
  sourceType: string | null;
}

/**
 * 未采用数据的原因词表（封闭）。
 *
 * 前半是观测投影的原因；后半是物料/投影降级的原因（NO-27a）——闭合枚举的价值在于
 * 前端必须为每个原因给出人话，不允许"多了个原因没人管"。
 */
export const SKIPPED_REASONS = [
  'stale_reading',
  'low_confidence',
  'unknown_subject',
  'capability_not_declared',
  'no_value',
  'no_threshold',
  'mixed_units',
  'unparsable_material_movement',
  'material_projection_failed',
  'material_source_unavailable',
] as const;
export type SkippedReason = (typeof SKIPPED_REASONS)[number];

/** 被跳过的读数（**必须**如实回报：现场要知道"数据没被采用，为什么"）。 */
export interface SkippedObservation {
  sensorId: string;
  subjectId: string | null;
  field: string;
  reason: SkippedReason;
  detail: string;
}

export interface ProjectObservationFactsInput {
  snapshot: WorldStateSnapshot | null | undefined;
  readings: EnvironmentReadingInput[];
  nowMs?: number;
  limits?: {
    vibrationMmPerSec?: number;
    freshnessMs?: number;
    minDataConfidence?: number;
  };
}

export interface ProjectObservationFactsResult {
  /** 只含**机器类**事实（振动超标）；其余资源类事实见 `collectResourceFacts`。 */
  facts: ReasoningFact[];
  evidence: ObservationEvidence[];
  skipped: SkippedObservation[];
  limits: { vibrationMmPerSec: number; freshnessMs: number; minDataConfidence: number };
}

/**
 * 数值归一：**缺失就是缺失**。
 *
 * `Number(null)` 是 0——曾把"人员没有负荷数据"静默变成"负荷 0 = 不超载"，
 * 属于原则 7 明确禁止的伪造。所有来自世界模型列的数值都必须过这一层。
 */
function toFiniteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 规范身份清洗。
 *
 * ⚠️ kind 必须来自 `contracts/identity` 的封闭注册表（fail-closed）：此前用
 * `env:` 前缀做读数证据，被 `isCanonicalIdentity` 直接拒绝——读数证据的 kind
 * 是 `sensor`（传感器），不是自造的 `env`。
 */
export const OBSERVATION_EVIDENCE_KIND = 'sensor';

/** 规范身份清洗：与 reasoning-trace 的 evidenceIds 约束一致（无空白/冒号/斜杠）。 */
function canonicalEvidenceValue(raw: string): string {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, 100);
}

/**
 * 把环境读数投影成"设备振动超标"事实。
 *
 * 判定链（每一步都可解释，缺一步就不产出事实）：
 *   1. 读数有 `vibration` 数值（无值 → `no_value`）；
 *   2. 数值 ≥ 阈值（否则不构成事实，属正常观测）；
 *   3. 读数新鲜（`ageMs ≤ freshnessMs`）→ 否则 `stale_reading`；
 *   4. 置信度 ≥ 下限 → 否则 `low_confidence`；
 *   5. 能映射到世界模型里的设备（`entity_id` 优先，其次 `sensor_id`）→ 否则 `unknown_subject`；
 *   6. 该设备**声明了** `observe.vibration` 观测能力 → 否则 `capability_not_declared`。
 */
export function projectObservationFacts(
  input: ProjectObservationFactsInput,
): ProjectObservationFactsResult {
  const nowMs = input.nowMs ?? Date.now();
  const limits = {
    vibrationMmPerSec: input.limits?.vibrationMmPerSec ?? OBSERVATION_LIMITS.vibrationMmPerSec,
    freshnessMs: input.limits?.freshnessMs ?? OBSERVATION_LIMITS.freshnessMs,
    minDataConfidence: input.limits?.minDataConfidence ?? OBSERVATION_LIMITS.minDataConfidence,
  };
  const devices = Array.isArray(input.snapshot?.devices) ? input.snapshot!.devices : [];
  const deviceByBusinessId = new Map<string, (typeof devices)[number]>();
  for (const device of devices) {
    const businessId = (device.deviceId ?? '').trim();
    if (businessId) deviceByBusinessId.set(businessId, device);
  }

  const facts: ReasoningFact[] = [];
  const evidence: ObservationEvidence[] = [];
  const skipped: SkippedObservation[] = [];
  const seenSubjects = new Set<string>();

  for (const reading of input.readings ?? []) {
    const sensorId = String(reading.sensorId ?? '').trim();
    const subjectKey = String(reading.entityId ?? reading.sensorId ?? '').trim();
    if (reading.vibration === null || reading.vibration === undefined || Number.isNaN(Number(reading.vibration))) {
      skipped.push({
        sensorId,
        subjectId: subjectKey || null,
        field: 'vibration',
        reason: 'no_value',
        detail: '该帧没有 vibration 读数',
      });
      continue;
    }
    const value = Number(reading.vibration);
    if (value < limits.vibrationMmPerSec) continue; // 正常观测：不产生事实，也不进 skipped 噪音

    const observedMs = Date.parse(String(reading.ts));
    const ageMs = Number.isFinite(observedMs) ? nowMs - observedMs : Number.POSITIVE_INFINITY;
    const confidence =
      reading.dataConfidence === null || reading.dataConfidence === undefined
        ? null
        : Number(reading.dataConfidence);
    const dataQuality: ObservationEvidence['dataQuality'] = !Number.isFinite(observedMs)
      ? 'UNKNOWN'
      : ageMs <= limits.freshnessMs
        ? 'FRESH'
        : 'STALE';

    if (dataQuality !== 'FRESH') {
      skipped.push({
        sensorId,
        subjectId: subjectKey || null,
        field: 'vibration',
        reason: 'stale_reading',
        detail: Number.isFinite(observedMs)
          ? `读数已过期 ${Math.round(ageMs / 60000)} 分钟（窗口 ${Math.round(limits.freshnessMs / 60000)} 分钟）`
          : '读数时间无法解析',
      });
      continue;
    }
    if (confidence === null || !Number.isFinite(confidence) || confidence < limits.minDataConfidence) {
      skipped.push({
        sensorId,
        subjectId: subjectKey || null,
        field: 'vibration',
        reason: 'low_confidence',
        detail:
          confidence === null
            ? '该帧未声明 data_confidence'
            : `data_confidence=${confidence} 低于下限 ${limits.minDataConfidence}`,
      });
      continue;
    }
    const device = deviceByBusinessId.get(subjectKey);
    if (!device) {
      skipped.push({
        sensorId,
        subjectId: subjectKey || null,
        field: 'vibration',
        reason: 'unknown_subject',
        detail: `世界模型中没有设备 ${subjectKey || '(空)'}（entity_id/sensor_id 都未匹配）`,
      });
      continue;
    }
    const observedCapabilities = Array.isArray(device.observedCapabilities)
      ? device.observedCapabilities
      : [];
    if (!observedCapabilities.includes('observe.vibration')) {
      skipped.push({
        sensorId,
        subjectId: subjectKey,
        field: 'vibration',
        reason: 'capability_not_declared',
        detail: `设备 ${subjectKey} 未声明观测能力 observe.vibration（能力模型权威，不据此判定风险）`,
      });
      continue;
    }

    const evidenceId = `${OBSERVATION_EVIDENCE_KIND}:${canonicalEvidenceValue(sensorId)}-${observedMs}`;
    const subjectId = `device:${canonicalEvidenceValue(subjectKey)}`;
    const entry: ObservationEvidence = {
      evidenceId,
      subjectId,
      capability: 'observe.vibration',
      field: 'vibration',
      value,
      threshold: limits.vibrationMmPerSec,
      unit: 'mm/s',
      observedAt: new Date(observedMs).toISOString(),
      ageMs: Math.max(0, ageMs),
      dataQuality,
      dataConfidence: confidence,
      sourceType: reading.sourceType ?? null,
    };
    evidence.push(entry);
    // 同一设备多条超标读数只保留一条事实（后到覆盖先到，与引擎按 subject 去重一致），
    // 但证据全保留——现场需要看到"连续几次都超标"。
    const existing = facts.findIndex((fact) => fact.subjectId === subjectId);
    const fact: ReasoningFact = {
      subjectId,
      kind: 'machine',
      values: { vibration: value, vibrationExceeded: true, threshold: limits.vibrationMmPerSec },
      evidenceIds: [evidenceId],
    };
    if (existing >= 0) {
      facts[existing] = {
        ...facts[existing],
        values: fact.values,
        evidenceIds: [...facts[existing].evidenceIds, evidenceId],
      };
    } else {
      facts.push(fact);
    }
    seenSubjects.add(subjectId);
  }

  return { facts, evidence, skipped, limits };
}

/**
 * 世界模型里的**资源类**事实（人员负荷 / 外骨骼电量 / 工位质量阻塞 / 告警升级）。
 *
 * 与观测投影分开：这些字段本来就是世界模型的权威列（不是"读数"），
 * 不需要新鲜度判断；但取值缺失时一律不产出事实（宁可不判定，也不猜 0）。
 */
export function collectResourceFacts(
  snapshot: WorldStateSnapshot | null | undefined,
): { facts: ReasoningFact[]; skipped: SkippedObservation[] } {
  const facts: ReasoningFact[] = [];
  const skipped: SkippedObservation[] = [];
  if (!snapshot) return { facts, skipped };

  for (const person of snapshot.persons ?? []) {
    const subjectId = `person:${canonicalEvidenceValue(person.id)}`;
    const workload = toFiniteOrNull(person.workload) ?? toFiniteOrNull(person.loadLevel);
    const fatigue = toFiniteOrNull(person.fatigueLevel);
    if (workload === null || fatigue === null) {
      skipped.push({
        sensorId: person.id,
        subjectId,
        field: 'workload',
        reason: 'no_value',
        detail: '人员负荷/疲劳度缺失（世界模型无该列值）',
      });
      continue;
    }
    facts.push({
      subjectId,
      kind: 'person',
      values: { workload, fatigue },
      evidenceIds: [`person:${canonicalEvidenceValue(person.id)}`],
    });
  }

  for (const device of snapshot.devices ?? []) {
    const businessId = (device.deviceId ?? '').trim();
    if (!businessId) continue;
    const subjectId = `device:${canonicalEvidenceValue(businessId)}`;
    const batteryPct = toFiniteOrNull(device.batteryPct);
    // 外骨骼电量：只在真实有电量读数时产出（无电池设备不得被当成 0%）
    if (batteryPct !== null) {
      facts.push({
        subjectId,
        kind: (device.deviceModel ?? '').toLowerCase().includes('exo') ? 'exo' : 'machine',
        values: { batteryPct },
        evidenceIds: [`device:${canonicalEvidenceValue(businessId)}`],
      });
    }
  }

  for (const station of snapshot.stations ?? []) {
    const findings = Array.isArray((station as { qualityFindings?: unknown }).qualityFindings)
      ? ((station as { qualityFindings?: Array<{ severity?: string | null; status?: string | null }> })
          .qualityFindings as Array<{ severity?: string | null; status?: string | null }>)
      : [];
    const blocking = findings.some((finding) => {
      const severity = String(finding?.severity ?? '').toLowerCase();
      const status = String(finding?.status ?? '').toLowerCase();
      return (severity === 'critical' || severity === 'high') && status !== 'closed' && status !== 'resolved';
    });
    if (blocking) {
      facts.push({
        subjectId: `station:${canonicalEvidenceValue(station.id)}`,
        kind: 'station',
        values: { qualityBlocked: true },
        evidenceIds: [`station:${canonicalEvidenceValue(station.id)}`],
      });
    }
  }

  for (const event of snapshot.events ?? []) {
    const severity = String((event as { severity?: string | null }).severity ?? '').toLowerCase();
    if (severity !== 'critical' && severity !== 'high') continue;
    const status = String((event as { status?: string | null }).status ?? '').toLowerCase();
    if (status !== 'open' && status !== 'acknowledged') continue;
    const id = String((event as { id?: string }).id ?? '');
    if (!id) continue;
    facts.push({
      subjectId: `alert:${canonicalEvidenceValue(id)}`,
      kind: 'alert',
      values: { andonRaised: true, unacknowledgedMinutes: 0 },
      evidenceIds: [`alert:${canonicalEvidenceValue(id)}`],
    });
  }

  return { facts, skipped };
}
