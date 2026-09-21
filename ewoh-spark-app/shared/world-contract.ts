/* 前后端共享契约 - Canonical Factory World State Contract（ADR-008 / NO-03）。
 *
 * 权威契约：contracts/world/world-state.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/world.py 逐项一致（共享向量约束）：
 * 双时态 [valid_from, valid_to) + sourceType real/simulated/derived +
 * confidence [0,1] + version；entityId 规范身份；版本单调/区间不重叠；
 * 模拟隔离（simulated 绝不参与 real 判定）。
 */

import { isCanonicalIdentity } from './identity';
import { DomainContractError } from './risk';
import {
  DEVICE_BUCKET_KINDS,
  PERSON_BUCKET_KINDS,
  STATION_BUCKET_KINDS,
  TASK_BUCKET_KINDS,
} from './entity-model';

export const WORLD_ENTITY_TYPES = [
  'person', 'exo', 'machine', 'robot', 'agv', 'tool', 'material',
  'container', 'inventory', 'order', 'operation', 'work_instruction',
  'task', 'station', 'zone', 'route', 'factory', 'warehouse', 'sensor',
  'event', 'risk', 'knowledge',
] as const;
export type WorldEntityType = (typeof WORLD_ENTITY_TYPES)[number];

export const WORLD_SOURCE_TYPES = ['real', 'simulated', 'derived'] as const;
export type WorldSourceType = (typeof WORLD_SOURCE_TYPES)[number];

export interface WorldStateRecord {
  stateId: string;
  entityId: string;
  entityType: WorldEntityType;
  /** Optional state category; snapshots without it fall back to entityType. */
  stateType?: string;
  stateJson: Record<string, unknown>;
  validFrom: string;
  validTo?: string | null;
  sourceType: WorldSourceType;
  confidence: number;
  version: number;
  observedAt?: string | null;
}

export interface WorldSnapshot {
  snapshotId: string;
  snapshotVersion: string;
  ts: string;
  worldVersion: number;
  entityVersions: Record<string, number>;
  states: WorldStateRecord[];
  source: 'AUTHORITATIVE' | 'DERIVED';
}

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(WORLD_ENTITY_TYPES);
const SOURCE_TYPE_SET: ReadonlySet<string> = new Set(WORLD_SOURCE_TYPES);

export function parseTs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim();
  if (text.endsWith('Z')) text = `${text.slice(0, -1)}+00:00`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/** 校验 StateRecord；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateWorldStateRecord(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  const required = ['stateId', 'entityId', 'entityType', 'stateJson', 'validFrom', 'sourceType', 'confidence', 'version'];
  for (const field of required) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.stateId !== 'string' || r.stateId === '') return ['bad_state_id'];
  if (typeof r.entityId !== 'string' || !isCanonicalIdentity(r.entityId)) return ['bad_entity_id'];
  if (!ENTITY_TYPE_SET.has(String(r.entityType))) return ['unknown_entity_type'];
  if (typeof r.stateJson !== 'object' || r.stateJson == null || Array.isArray(r.stateJson)) return ['bad_state_json'];
  if (!SOURCE_TYPE_SET.has(String(r.sourceType))) return ['unknown_source_type'];
  if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) return ['bad_confidence'];
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return ['bad_version'];
  const validFrom = parseTs(r.validFrom);
  if (validFrom == null) return ['bad_valid_from'];
  if (r.validTo != null) {
    const validTo = parseTs(r.validTo);
    if (validTo == null || validTo < validFrom) return ['bad_interval'];
  }
  return [];
}

/** 同 (entityId, stateType) 区间集合校验：不重叠 + 版本单调。 */
export function validateWorldIntervalSet(records: unknown[]): string[] {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const raw of records) {
    if (raw == null || typeof raw !== 'object') return ['record_must_be_object'];
    const r = raw as Record<string, unknown>;
        // Canonical records may omit stateType when entityType is the only state
        // category. The fallback keeps grouping explicit instead of collapsing
        // every entity into the literal "undefined" state bucket.
        const stateType = typeof r.stateType === 'string' && r.stateType.trim() !== ''
          ? r.stateType
          : r.entityType;
        const key = `${String(r.entityId)}|${String(stateType)}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => {
      const af = parseTs(a.validFrom) ?? Number.POSITIVE_INFINITY;
      const bf = parseTs(b.validFrom) ?? Number.POSITIVE_INFINITY;
      return af - bf;
    });
    let prevEnd: number | null = null;
    let prevVersion = 0;
    let first = true;
    for (const r of ordered) {
      const vf = parseTs(r.validFrom);
      if (vf == null) return ['bad_valid_from'];
      if (prevEnd != null && vf < prevEnd) return ['overlapping_interval'];
      const version = r.version as number;
      // 快照可只含当前记录（版本单调性只在同键多记录时校验：从 1 起连续递增）
      if (!first && (typeof version !== 'number' || !Number.isInteger(version) || version !== prevVersion + 1)) {
        return ['version_not_monotonic'];
      }
      first = false;
      prevVersion = version;
      prevEnd = r.validTo != null ? parseTs(r.validTo) : null;
    }
  }
  return [];
}

/** 校验 Snapshot：字段 + entityVersions 键为规范身份 + states 合法 + 区间集合。 */
export function validateWorldSnapshot(snapshot: unknown): string[] {
  if (snapshot == null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['record_must_be_object'];
  }
  const s = snapshot as Record<string, unknown>;
  const required = ['snapshotId', 'snapshotVersion', 'ts', 'worldVersion', 'entityVersions', 'states'];
  for (const field of required) {
    if (!(field in s)) return [`missing_field:${field}`];
  }
  if (typeof s.worldVersion !== 'number' || !Number.isInteger(s.worldVersion) || s.worldVersion < 0) {
    return ['bad_world_version'];
  }
  if (typeof s.entityVersions !== 'object' || s.entityVersions == null || Array.isArray(s.entityVersions)) {
    return ['bad_entity_versions'];
  }
  for (const [key, version] of Object.entries(s.entityVersions as Record<string, unknown>)) {
    if (!isCanonicalIdentity(key)) return ['bad_entity_version_key'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return ['bad_entity_version_value'];
  }
  if (!Array.isArray(s.states)) return ['bad_states'];
  // SH-007：收集全部错误再返回（与 Python validate_snapshot 语义一致：
  // 每条 state 的首错 + 区间集合错误，不因首条 state 错误中断）。
  const errors: string[] = [];
  for (const state of s.states) {
    const recordErrors = validateWorldStateRecord(state);
    if (recordErrors.length > 0) errors.push(recordErrors[0]);
  }
  errors.push(...validateWorldIntervalSet(s.states as unknown[]));
  return errors;
}

/** 云侧 WorldStateSnapshot 的契约校验（NO-03b：构建时自检）。
 *
 * 适用契约子集（云侧快照为权威投影，非 StateRecord 集合）：
 *  - worldVersion >= 0；
 *  - entityVersions 键必须规范身份；
 *  - 实体数组的 entityId（存在时）必须规范身份且 kind 命中对应投影桶
 *    （ADR-015 projectionBuckets：person/station/task 单 kind；device 桶 =
 *    遗留身份桶 device + 设备类实体 kind exo/machine/robot/agv/sensor）。
 * 返回错误码列表（空 = 合法）。
 */
export function validateCloudWorldSnapshot(snapshot: {
  worldVersion: number;
  entityVersions: Record<string, number>;
  persons?: Array<{ entityId?: string }>;
  devices?: Array<{ entityId?: string }>;
  stations?: Array<{ entityId?: string }>;
  tasks?: Array<{ entityId?: string }>;
}): string[] {
  const errors: string[] = [];
  if (typeof snapshot.worldVersion !== 'number' || !Number.isInteger(snapshot.worldVersion) || snapshot.worldVersion < 0) {
    errors.push('bad_world_version');
  }
  if (snapshot.entityVersions == null || typeof snapshot.entityVersions !== 'object' || Array.isArray(snapshot.entityVersions)) {
    errors.push('bad_entity_versions');
  } else {
    for (const [key, version] of Object.entries(snapshot.entityVersions)) {
      if (!isCanonicalIdentity(key)) errors.push('bad_entity_version_key');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) errors.push('bad_entity_version_value');
    }
  }
  const checkRefs = (entities: Array<{ entityId?: string }> | undefined, bucket: readonly string[]) => {
    for (const entity of entities ?? []) {
      if (entity.entityId == null) continue;
      if (!isCanonicalIdentity(entity.entityId)) {
        errors.push('bad_entity_ref');
        continue;
      }
      const kind = entity.entityId.slice(0, entity.entityId.indexOf(':'));
      if (!bucket.includes(kind)) errors.push('bad_entity_ref_kind');
    }
  };
  checkRefs(snapshot.persons, PERSON_BUCKET_KINDS);
  checkRefs(snapshot.devices, DEVICE_BUCKET_KINDS);
  checkRefs(snapshot.stations, STATION_BUCKET_KINDS);
  checkRefs(snapshot.tasks, TASK_BUCKET_KINDS);
  return errors;
}

/** 来源画像：simulatedOnly / hasReal（契约规则 3 的机器可执行面）。 */
export function worldSnapshotSourceProfile(states: unknown[]): { simulatedOnly: boolean; hasReal: boolean } {
  const sources = new Set(
    states
      .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object')
      .map((s) => String(s.sourceType)),
  );
  return {
    simulatedOnly: sources.size > 0 && sources.size === 1 && sources.has('simulated'),
    hasReal: sources.has('real'),
  };
}
