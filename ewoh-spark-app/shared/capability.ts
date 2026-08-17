/* Canonical Capability Model（ADR-043 / §3/§4，NO-12t）。
 *
 * 权威契约：contracts/capability/capability.schema.json +
 * capability.test-vectors.json。
 * 语义与 src/edge_platform/contracts/capability.py 逐项一致
 * （audit-domain-contracts capability 域跨语言仲裁）。
 */

export const CAPABILITY_KINDS = [
  'skill',
  'certification',
  'device_capability',
  'station_capability',
  'exo_capability',
] as const;

export const PROVIDER_TYPES = [
  'person',
  'device',
  'exo',
  'machine',
  'robot',
  'station',
  'tool',
] as const;

/** 平台已知能力值登记（文档/测试向量锁定；name 词表本身开放——工厂技能天然开放）。 */
export const KNOWN_CAPABILITY_VALUES = [
  'forklift',
  'first_aid',
  'exo-lift',
  'vacuum',
  'assembly',
  'inspection',
  'material_handling',
] as const;

const KIND_SET: ReadonlySet<string> = new Set(CAPABILITY_KINDS);
const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDER_TYPES);

/** CapabilityRecord 形状（与 contracts/capability/capability.schema.json 一致）。 */
export interface CapabilityRecord {
  capabilityId: string;
  kind: string;
  name: string;
  providerType: string;
  subject: string;
  grantedAt?: string;
  expiresAt?: string;
  issuer?: string;
  evidence?: string[];
  auditTrail: boolean;
}

const REQUIRED_FIELDS = [
  'capabilityId',
  'kind',
  'name',
  'providerType',
  'subject',
  'auditTrail',
] as const;

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** CapabilityRecord 契约校验（fail-closed）；返回错误码列表（空=合法）。 */
export function validateCapability(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.capabilityId !== 'string' || r.capabilityId.trim() === '') {
    return ['bad_capability_id'];
  }
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  const name = r.name;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 100) {
    return ['bad_name'];
  }
  if (!PROVIDER_SET.has(String(r.providerType))) return ['unknown_provider_type'];
  const subject = r.subject;
  if (
    typeof subject !== 'string' ||
    !subject.includes(':') ||
    subject.startsWith(':') ||
    subject.endsWith(':')
  ) {
    return ['bad_subject'];
  }
  const grantedAt = r.grantedAt;
  const expiresAt = r.expiresAt;
  if (grantedAt !== undefined && isoMs(grantedAt) === null) return ['bad_granted_at'];
  if (expiresAt !== undefined && isoMs(expiresAt) === null) return ['bad_expires_at'];
  if (r.kind === 'certification') {
    if (typeof r.issuer !== 'string' || r.issuer.trim() === '') {
      return ['certification_missing_issuer'];
    }
    if (isoMs(expiresAt) === null) return ['certification_missing_expiry'];
  } else if (r.issuer !== undefined && (typeof r.issuer !== 'string' || r.issuer.trim() === '')) {
    return ['bad_issuer'];
  }
  if (grantedAt !== undefined && expiresAt !== undefined) {
    const g = isoMs(grantedAt);
    const e = isoMs(expiresAt);
    if (g !== null && e !== null && e < g) return ['time_order_violation'];
  }
  // R2-SHR-008：仅缺键（undefined）默认 []；显式 null 是脏数据
  // （bad_evidence），不再隐式归一——与 Python capability.py 对齐。
  const evidence = r.evidence === undefined ? [] : r.evidence;
  if (!Array.isArray(evidence)) return ['bad_evidence'];
  for (const item of evidence) {
    if (typeof item !== 'string' || item.trim() === '') return ['bad_evidence'];
  }
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}
