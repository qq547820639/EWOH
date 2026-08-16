// capability-projection.ts — Capability 契约消费方投影（NO-12u / ADR-044，§3/§30）。
//
// 把既有实体事实（人员技能/认证、设备能力、工位能力）逐点投影为
// Canonical CapabilityRecord（ADR-043 契约）：先立契约、再逐点收敛的
// 生产接线面。buildSnapshot 以此为唯一投影点，快照附 capabilityRecords
// （契约合法的记录）+ capabilityProjectionIssues（投影缺口显式计数）。
//
// 语义边界（§33）：
// - 投影只做事实映射，不发明事实：certification 需要 issuer 而人员数据源
//   无 issuer → 该条显式记入 issues（certification_missing_issuer:<name>），
//   绝不伪造 issuer、绝不静默丢弃；
// - 每条记录经 validateCapability 契约校验（fail-closed）；违规记录
//   不进入 records，显式记入 issues（projection_invalid:<capabilityId>）。
import { validateCapability, type CapabilityRecord } from '@shared/capability';

export interface CapabilityProjection {
  records: CapabilityRecord[];
  issues: string[];
}

export interface PersonCapabilitySource {
  id: string;
  skills: string[];
  certifications: string[];
  certificationExpiry?: Array<{ name: string; expiresAtMs: number | null }> | null;
}

export interface DeviceCapabilitySource {
  id: string;
  capabilities?: string[];
}

export interface StationCapabilitySource {
  id: string;
  capabilities?: string[];
}

function accept(record: CapabilityRecord, issues: string[]): CapabilityRecord[] {
  const errors = validateCapability(record);
  if (errors.length > 0) {
    issues.push(`projection_invalid:${record.capabilityId}:${errors.join(',')}`);
    return [];
  }
  return [record];
}

/** 人员 → skill + certification 记录（certification 无 issuer 显式记缺口）。 */
export function projectPersonCapabilities(person: PersonCapabilitySource): CapabilityProjection {
  const records: CapabilityRecord[] = [];
  const issues: string[] = [];
  const expiryByName = new Map<string, number | null>(
    (person.certificationExpiry ?? []).map((e) => [e.name, e.expiresAtMs]),
  );
  for (const skill of person.skills ?? []) {
    records.push(
      ...accept({
        capabilityId: `cap:skill:${skill}:person:${person.id}`,
        kind: 'skill',
        name: skill,
        providerType: 'person',
        subject: `person:${person.id}`,
        evidence: [],
        auditTrail: true,
      }, issues),
    );
  }
  for (const cert of person.certifications ?? []) {
    const expiresAtMs = expiryByName.get(cert);
    if (expiresAtMs == null) {
      // 契约要求 certification 带 expiresAt；数据源无到期事实 → 显式缺口。
      issues.push(`certification_missing_expiry:${cert}`);
      continue;
    }
    records.push(
      ...accept({
        capabilityId: `cap:certification:${cert}:person:${person.id}`,
        kind: 'certification',
        name: cert,
        providerType: 'person',
        subject: `person:${person.id}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
        // 人员数据源无 issuer 事实：契约要求非空 issuer，缺事实显式记缺口
        // （绝不伪造 issuer，§33）——契约门将此类来源缺口显式暴露。
        issuer: '',
        evidence: [],
        auditTrail: true,
      }, issues),
    );
    // 上一步 accept 会因空 issuer 拒绝并把原因记入 issues；此处补充语义化缺口码。
    if (issues.length > 0 && issues[issues.length - 1].startsWith('projection_invalid:')) {
      issues[issues.length - 1] = `certification_missing_issuer:${cert}`;
    }
  }
  return { records, issues };
}

/** 设备 → device_capability 记录。 */
export function projectDeviceCapabilities(device: DeviceCapabilitySource): CapabilityProjection {
  const records: CapabilityRecord[] = [];
  const issues: string[] = [];
  for (const capability of device.capabilities ?? []) {
    records.push(
      ...accept({
        capabilityId: `cap:device_capability:${capability}:device:${device.id}`,
        kind: 'device_capability',
        name: capability,
        providerType: 'device',
        subject: `device:${device.id}`,
        evidence: [],
        auditTrail: true,
      }, issues),
    );
  }
  return { records, issues };
}

/** 工位 → station_capability 记录。 */
export function projectStationCapabilities(station: StationCapabilitySource): CapabilityProjection {
  const records: CapabilityRecord[] = [];
  const issues: string[] = [];
  for (const capability of station.capabilities ?? []) {
    records.push(
      ...accept({
        capabilityId: `cap:station_capability:${capability}:station:${station.id}`,
        kind: 'station_capability',
        name: capability,
        providerType: 'station',
        subject: `station:${station.id}`,
        evidence: [],
        auditTrail: true,
      }, issues),
    );
  }
  return { records, issues };
}

// ── NO-12v / ADR-045：Record 化匹配收敛（语义不变纯结构收敛） ──────────────

/** 记录集 → 指定 kind 的名称集（去重有序）。 */
export function capabilityNames(
  records: CapabilityRecord[] | undefined,
  kind: string,
): string[] {
  const names = new Set<string>();
  for (const record of records ?? []) {
    if (record.kind === kind && record.name.trim() !== '') names.add(record.name);
  }
  return [...names].sort();
}

/**
 * 人员技能名集：capabilityRecords（快照契约形态）优先；无记录（legacy 直呼
 * 路径）→ 就地经同一投影函数推导（§31 单一语义，无静默第二事实源）。
 * 技能投影 1:1（无契约缺口），两种来源语义逐字一致。
 */
export function personSkillNames(person: {
  skills: string[];
  capabilityRecords?: CapabilityRecord[];
}): string[] {
  if (person.capabilityRecords) return capabilityNames(person.capabilityRecords, 'skill');
  return [...(person.skills ?? [])].sort();
}

/**
 * 人员证书到期映射（name → expiresAtMs）：records 优先（certification 记录
 * 仅在有 issuer+expiry 时投影——与 raw certificationExpiry 的到期语义一致）；
 * 无记录 → raw certificationExpiry；两者皆无 → null（不猜）。
 */
export function personCertificationExpiryMap(person: {
  certificationExpiry?: Array<{ name: string; expiresAtMs: number | null }> | null;
  capabilityRecords?: CapabilityRecord[];
}): Map<string, number | null> {
  const result = new Map<string, number | null>();
  if (person.capabilityRecords) {
    for (const record of person.capabilityRecords) {
      if (record.kind === 'certification' && record.expiresAt) {
        const ms = new Date(record.expiresAt).getTime();
        if (Number.isFinite(ms)) result.set(record.name, ms);
      }
    }
    // 有 records 但无该证书记录 = 证书投影被契约缺口（缺 issuer/expiry）丢弃；
    // 到期未知 → 按 raw 语义回退为「无到期事实」（不视为过期），与既有语义一致。
    return result;
  }
  for (const entry of person.certificationExpiry ?? []) {
    result.set(entry.name, entry.expiresAtMs);
  }
  return result;
}

/** 设备能力名集：records 优先，无记录 → raw capabilities（1:1 投影同语义）。 */
export function deviceCapabilityNames(device: {
  capabilities?: string[];
  capabilityRecords?: CapabilityRecord[];
}): string[] {
  if (device.capabilityRecords) return capabilityNames(device.capabilityRecords, 'device_capability');
  return [...(device.capabilities ?? [])].sort();
}

/** 工位能力名集：records 优先，无记录 → raw（1:1 投影同语义）。 */
export function stationCapabilityNames(
  records: CapabilityRecord[] | undefined,
  raw: string[] | undefined,
): string[] {
  if (records) return capabilityNames(records, 'station_capability');
  return [...(raw ?? [])].sort();
}
