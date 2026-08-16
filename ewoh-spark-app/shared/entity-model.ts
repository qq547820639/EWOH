/* 前后端共享契约 - Canonical Factory Entity Model（ADR-015 / NO-03a）。
 *
 * 权威契约：contracts/entity/entity-model.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/entity_model.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';
import { parseEnvelopeTs } from './event-envelope';

/* ---GEN-BEGIN:entity-registries--- */
// 自动生成（scripts/gen-contract-registries.js --write）；权威源 contracts/entity/entity-model.schema.json。
// 请勿手改本生成区；漂移由 make truth-check 的 gen-contract-registries --check 拦截。
export const ENTITY_KINDS = ['person', 'worker_capability', 'skill',
  'certification', 'fatigue', 'workload', 'ergonomic_risk', 'exo',
  'machine', 'robot', 'agv', 'tool', 'material', 'container', 'inventory',
  'order', 'production_order', 'operation', 'task', 'work_instruction',
  'station', 'zone', 'route', 'factory', 'warehouse', 'sensor',
  'observation', 'event', 'alert', 'incident', 'risk', 'quality_finding',
  'maintenance_condition', 'reservation', 'assignment', 'plan',
  'decision', 'approval', 'execution', 'outcome', 'policy', 'constraint',
  'model', 'agent', 'knowledge',] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const ENTITY_SOURCES = ['real', 'simulated', 'derived'] as const;
export type EntitySource = (typeof ENTITY_SOURCES)[number];
export const WORLD_STATE_PROJECTABLE_KINDS = ['person', 'exo', 'machine',
  'robot', 'agv', 'tool', 'material', 'container', 'inventory', 'order',
  'operation', 'work_instruction', 'task', 'station', 'zone', 'route',
  'factory', 'warehouse', 'sensor', 'event', 'risk', 'knowledge',] as const;
export const PERSON_BUCKET_KINDS = ['person'] as const;
export const DEVICE_BUCKET_KINDS = ['device', 'exo', 'machine', 'robot', 'agv', 'sensor'] as const;
export const STATION_BUCKET_KINDS = ['station'] as const;
export const TASK_BUCKET_KINDS = ['task'] as const;
/* ---GEN-END:entity-registries--- */

/* 权威投影分工（ADR-015，schema projectionDivision / projectionBuckets 锁定）。
 * 可观察状态投影 = world-state 契约的 22 类注册表（生成区
 * WORLD_STATE_PROJECTABLE_KINDS 由 schema 生成，门禁交叉强制）；云侧粗粒度投影桶
 * （person/device/station/task）→ 实体 kind 的显式映射（device 桶 = 遗留身份桶
 * device + 设备类实体 kind exo/machine/robot/agv/sensor）。
 */
export const PROJECTION_BUCKETS: Readonly<Record<'person' | 'device' | 'station' | 'task', readonly string[]>> = {
  person: PERSON_BUCKET_KINDS,
  device: DEVICE_BUCKET_KINDS,
  station: STATION_BUCKET_KINDS,
  task: TASK_BUCKET_KINDS,
};

const KIND_SET: ReadonlySet<string> = new Set(ENTITY_KINDS);
const SOURCE_SET: ReadonlySet<string> = new Set(ENTITY_SOURCES);
const PROJECTABLE_SET: ReadonlySet<string> = new Set(WORLD_STATE_PROJECTABLE_KINDS);

/** kind 是否属于可观察状态投影（world-state 22 类）；其余为声明型实体。 */
export function isStateProjectable(kind: string): boolean {
  return PROJECTABLE_SET.has(kind);
}

/** 校验实体声明；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateEntityDeclaration(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['entityId', 'kind', 'tenantId', 'factoryId', 'timeSemantics', 'status', 'source', 'version']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.entityId !== 'string' || !isCanonicalIdentity(r.entityId)) {
    return ['bad_entity_id'];
  }
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  // kind 前缀一致性：kind:value 的 kind 部分即实体类别；身份专属 kind（device/session）
  // 不得承载实体声明（kind_prefix_unknown），实体 kind 前缀与声明 kind 不一致拒绝。
  const prefix = String(r.entityId).split(':')[0];
  if (!KIND_SET.has(prefix)) return ['kind_prefix_unknown'];
  if (prefix !== String(r.kind)) return ['kind_prefix_mismatch'];
  if (typeof r.tenantId !== 'string' || r.tenantId === '') return ['bad_tenant'];
  if (typeof r.factoryId !== 'string' || r.factoryId === '') return ['bad_factory'];
  const timeSem = r.timeSemantics;
  if (typeof timeSem !== 'object' || timeSem === null || Array.isArray(timeSem)) {
    return ['bad_time'];
  }
  const ts = timeSem as Record<string, unknown>;
  if (!('validFrom' in ts)) return ['bad_time'];
  const validFrom = parseEnvelopeTs(String(ts.validFrom));
  if (validFrom == null) return ['bad_time'];
  if (ts.validTo != null) {
    const validTo = parseEnvelopeTs(String(ts.validTo));
    if (validTo == null) return ['bad_time'];
    if (validTo < validFrom) return ['bad_time'];
  }
  if (typeof r.status !== 'string' || r.status === '') return ['bad_status'];
  if (!SOURCE_SET.has(String(r.source))) return ['unknown_source'];
  const version = r.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return ['bad_version'];
  }
  const confidence = r.confidence;
  if (confidence != null) {
    if (
      typeof confidence !== 'number' || Number.isNaN(confidence) ||
      confidence < 0 || confidence > 1
    ) {
      return ['bad_confidence'];
    }
  }
  for (const key of ['refs', 'eventRefs']) {
    const refs = r[key];
    if (refs == null) continue;
    if (!Array.isArray(refs) || refs.some((x) => typeof x !== 'string' || !isCanonicalIdentity(x))) {
      return ['bad_ref'];
    }
  }
  return [];
}
