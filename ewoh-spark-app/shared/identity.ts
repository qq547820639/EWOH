/* 前后端共享契约 - Canonical Industrial Identity（ADR-006 / Phase 2 NO-02）。
 *
 * 权威契约：contracts/identity/identity.schema.json（kind 注册表 + 语法 + 规则）与
 * contracts/identity/test-vectors.json（跨语言一致性向量）。本模块是云侧的锁定实现：
 * IDENTITY_KINDS 必须与 schema.kindRegistry 逐项一致，由
 * scripts/audit-identity-contracts.js 门禁强制（CI + make truth-check）。
 *
 * 语义与 src/edge_platform/contracts/identity.py 完全一致（同一份测试向量约束）：
 * - 规范形式 `kind:value`，恰好一个冒号，字节相等即身份相等，大小写敏感；
 * - kind 封闭注册表，未知 kind → 拒绝（fail-closed，禁止猜测）；
 * - value 由 EWOH 生成（推荐 UUID v4），第三方 ID 仅经 mapping 记录关联为 alias；
 * - mapping 解析：仅 active 且时间窗口有效者参与；精确匹配 1 条返回；
 *   ≥2 条抛 IdentityConflictError；0 条返回 null（未映射）。
 */

/** 锁定注册表：与 contracts/identity/identity.schema.json 的 kindRegistry 逐项一致。 */
export const IDENTITY_KINDS = [
  'person',
  'exo',
  'device',
  'machine',
  'robot',
  'agv',
  'tool',
  'material',
  'container',
  'inventory',
  'order',
  'task',
  'operation',
  'work_instruction',
  'station',
  'zone',
  'route',
  'factory',
  'warehouse',
  'sensor',
  'event',
  'alert',
  'incident',
  'risk',
  'quality_finding',
  'maintenance_condition',
  'reservation',
  'assignment',
  'plan',
  'decision',
  'approval',
  'execution',
  'outcome',
  'policy',
  'constraint',
  'model',
  'agent',
  'knowledge',
  'skill',
  'certification',
  'session',
  'observation',
] as const;

export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export const IDENTITY_KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const IDENTITY_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$/;
export const IDENTITY_MAX_VALUE_LENGTH = 128;

export type MappingAuthority = 'registration' | 'adapter' | 'manual';
export type MappingStatus = 'active' | 'superseded' | 'revoked';

export interface IdentityMappingRecord {
  mappingId: string;
  version: number;
  source: { system: string; id: string; idKind?: string };
  target: { entityId: string };
  authority: MappingAuthority;
  status: MappingStatus;
  recordedAt: string;
  validFrom?: string | null;
  validTo?: string | null;
  evidenceId?: string | null;
}

export type IdentityErrorCode =
  | 'not_a_string'
  | 'bad_canonical_form'
  | 'unknown_kind'
  | 'bad_value'
  | 'ambiguous_identity';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export class IdentityConflictError extends IdentityError {
  constructor(system: string, sourceId: string, count: number) {
    super(
      'ambiguous_identity',
      `ambiguous_identity: system=${JSON.stringify(system)} id=${JSON.stringify(sourceId)} 命中 ${count} 条 active 映射，fail-closed`,
    );
    this.name = 'IdentityConflictError';
  }
}

const KIND_SET: ReadonlySet<string> = new Set<string>(IDENTITY_KINDS);

/** 解析规范身份 `kind:value` → {kind, value}；非法抛 IdentityError（fail-closed）。 */
export function parseIdentity(identity: string): { kind: IdentityKind; value: string } {
  if (typeof identity !== 'string') {
    throw new IdentityError('not_a_string', `身份必须是字符串，收到 ${typeof identity}`);
  }
  const colonCount = identity.split(':').length - 1;
  if (colonCount !== 1) {
    throw new IdentityError('bad_canonical_form', `身份必须为 kind:value 单冒号形式: ${JSON.stringify(identity)}`);
  }
  const idx = identity.indexOf(':');
  const kind = identity.slice(0, idx);
  const value = identity.slice(idx + 1);
  if (!KIND_SET.has(kind)) {
    throw new IdentityError('unknown_kind', `kind 不在注册表: ${JSON.stringify(kind)}`);
  }
  if (!IDENTITY_VALUE_PATTERN.test(value)) {
    throw new IdentityError('bad_value', `value 语法非法（≤128 字符，禁止 ':' '/' '%' 空白）: ${JSON.stringify(value)}`);
  }
  return { kind: kind as IdentityKind, value };
}

/** 组装规范身份；任一字段非法即抛 IdentityError（不静默产出）。 */
export function formatIdentity(kind: IdentityKind, value: string): string {
  if (!KIND_SET.has(kind)) {
    throw new IdentityError('unknown_kind', `kind 不在注册表: ${JSON.stringify(kind)}`);
  }
  if (!IDENTITY_VALUE_PATTERN.test(value)) {
    throw new IdentityError('bad_value', `value 语法非法: ${JSON.stringify(value)}`);
  }
  return `${kind}:${value}`;
}

/** candidate 是否为合法规范身份（不抛异常）。 */
export function isCanonicalIdentity(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false;
  try {
    parseIdentity(candidate);
    return true;
  } catch {
    return false;
  }
}

export function kindOf(identity: string): IdentityKind {
  return parseIdentity(identity).kind;
}

export function valueOf(identity: string): string {
  return parseIdentity(identity).value;
}

function parseIso(value: string | null | undefined): Date | null {
  if (value == null || value.trim() === '') return null;
  const normalized = value.trim().endsWith('Z') ? value.trim().slice(0, -1) + '+00:00' : value.trim();
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 按契约解析第三方 (system, id) → 规范身份（与 Python 语义逐项一致）。
 *
 * mappings 接受 unknown 数组：形状非法的记录被跳过（不参与解析、不被信任），
 * 与 Python 侧 `resolve_identity_mapping` 的 fail-closed 语义一致。
 */
export function resolveIdentityMapping(
  system: string,
  sourceId: string,
  mappings: ReadonlyArray<unknown>,
  now?: string | null,
): string | null {
  const nowDate = now != null ? parseIso(now) : null;
  const hits: string[] = [];
  for (const raw of mappings) {
    if (raw == null || typeof raw !== 'object') continue;
    const record = raw as Partial<IdentityMappingRecord>;
    const source = record.source;
    const target = record.target;
    if (source == null || target == null) continue;
    if (record.status !== 'active') continue;
    if (source.system !== system || source.id !== sourceId) continue;
    if (nowDate != null) {
      const validFrom = parseIso(record.validFrom ?? null);
      const validTo = parseIso(record.validTo ?? null);
      if (validFrom != null && nowDate.getTime() < validFrom.getTime()) continue;
      if (validTo != null && nowDate.getTime() >= validTo.getTime()) continue;
    }
    if (typeof target.entityId === 'string') hits.push(target.entityId);
  }
  const unique = [...new Set(hits)];
  if (unique.length > 1) {
    throw new IdentityConflictError(system, sourceId, unique.length);
  }
  return unique.length === 1 ? unique[0] : null;
}

const MAPPING_STATUSES: ReadonlySet<string> = new Set(['active', 'superseded', 'revoked']);
const MAPPING_AUTHORITIES: ReadonlySet<string> = new Set(['registration', 'adapter', 'manual']);
const MAPPING_REQUIRED_FIELDS = ['mappingId', 'version', 'source', 'target', 'authority', 'status', 'recordedAt'];

/** 校验 identity-mapping 记录语义（等价 identity-mapping.schema.json 子集）。返回错误列表，空 = 合法。 */
export function validateMappingRecord(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const rec = record as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of MAPPING_REQUIRED_FIELDS) {
    if (!(field in rec)) errors.push(`missing_field:${field}`);
  }
  if (errors.length > 0) return errors;

  if (typeof rec.mappingId !== 'string' || !/^map:[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$/.test(rec.mappingId)) {
    errors.push('bad_mapping_id');
  }
  if (typeof rec.version !== 'number' || !Number.isInteger(rec.version) || rec.version < 1) {
    errors.push('bad_version');
  }
  if (typeof rec.status !== 'string' || !MAPPING_STATUSES.has(rec.status)) {
    errors.push('bad_status');
  }
  if (typeof rec.authority !== 'string' || !MAPPING_AUTHORITIES.has(rec.authority)) {
    errors.push('bad_authority');
  }

  const source = rec.source as Record<string, unknown> | undefined;
  if (source == null || typeof source !== 'object') {
    errors.push('bad_source');
  } else {
    if (typeof source.system !== 'string' || source.system.length < 1 || source.system.length > 64) {
      errors.push('bad_source_system');
    }
    if (typeof source.id !== 'string' || source.id.length < 1 || source.id.length > 255) {
      errors.push('bad_source_id');
    }
  }

  const target = rec.target as Record<string, unknown> | undefined;
  if (target == null || typeof target !== 'object') {
    errors.push('bad_target');
  } else if (typeof target.entityId !== 'string' || !isCanonicalIdentity(target.entityId)) {
    errors.push('bad_target_entity_id');
  }

  if (typeof rec.recordedAt !== 'string' || parseIso(rec.recordedAt) == null) {
    errors.push('bad_recorded_at');
  }
  if (rec.validFrom != null && parseIso(rec.validFrom as string) == null) {
    errors.push('bad_valid_from');
  }
  if (rec.validTo != null && parseIso(rec.validTo as string) == null) {
    errors.push('bad_valid_to');
  }

  return errors;
}
