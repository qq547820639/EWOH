/* capability.spec.ts — Canonical Capability Model TS 实现（ADR-043 / NO-12t）。
 *
 * 与 contracts/capability/capability.test-vectors.json 共享向量语义
 * （audit-domain-contracts capability 域跨语言仲裁 + Golden 第 23 场景）。
 */
import { CAPABILITY_KINDS, KNOWN_CAPABILITY_VALUES, PROVIDER_TYPES, validateCapability } from './capability';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilityId: 'cap:skill:forklift:person:p1',
    kind: 'skill',
    name: 'forklift',
    providerType: 'person',
    subject: 'person:p1',
    evidence: [],
    auditTrail: true,
    ...overrides,
  };
}

describe('validateCapability（Canonical Capability Model）', () => {
  it('注册表形状：3 注册表封闭 + 已知值登记（已知值必须合法）', () => {
    expect(CAPABILITY_KINDS).toHaveLength(5);
    expect(PROVIDER_TYPES).toHaveLength(7);
    for (const value of KNOWN_CAPABILITY_VALUES) {
      expect(validateCapability(record({ name: value }))).toEqual([]);
    }
  });

  it('五类 kind 全部合法（skill/certification/device/station/exo）', () => {
    expect(validateCapability(record({ kind: 'skill' }))).toEqual([]);
    expect(
      validateCapability(record({
        kind: 'certification',
        issuer: 'org:red-cross',
        expiresAt: '2027-08-01T00:00:00Z',
      })),
    ).toEqual([]);
    expect(validateCapability(record({
      kind: 'device_capability', name: 'exo-lift', providerType: 'device', subject: 'device:exo-1',
    }))).toEqual([]);
    expect(validateCapability(record({
      kind: 'station_capability', name: 'assembly', providerType: 'station', subject: 'station:s1',
    }))).toEqual([]);
    expect(validateCapability(record({
      kind: 'exo_capability', name: 'exo-lift', providerType: 'exo', subject: 'exo:e1',
    }))).toEqual([]);
  });

  it('未知 kind/providerType → 显式拒绝（结构注册表封闭）', () => {
    expect(validateCapability(record({ kind: 'future_kind' }))).toEqual(['unknown_kind']);
    expect(validateCapability(record({ providerType: 'vehicle' }))).toEqual(['unknown_provider_type']);
  });

  it('开放词表：未知 name 合法（工厂技能天然开放）但空/超长拒绝', () => {
    expect(validateCapability(record({ name: 'custom_skill_xyz' }))).toEqual([]);
    expect(validateCapability(record({ name: '  ' }))).toEqual(['bad_name']);
    expect(validateCapability(record({ name: 'x'.repeat(101) }))).toEqual(['bad_name']);
  });

  it('certification：issuer + expiresAt 必填（判定事实完整）', () => {
    expect(validateCapability(record({
      kind: 'certification', expiresAt: '2027-08-01T00:00:00Z',
    }))).toEqual(['certification_missing_issuer']);
    expect(validateCapability(record({
      kind: 'certification', issuer: 'org:red-cross',
    }))).toEqual(['certification_missing_expiry']);
  });

  it('时间不倒退（expiresAt < grantedAt → 显式拒绝）', () => {
    expect(validateCapability(record({
      kind: 'certification',
      issuer: 'org:red-cross',
      grantedAt: '2027-08-01T00:00:00Z',
      expiresAt: '2026-08-01T00:00:00Z',
    }))).toEqual(['time_order_violation']);
  });

  it('subject 规范身份形状 + auditTrail 强制', () => {
    expect(validateCapability(record({ subject: 'person-p1' }))).toEqual(['bad_subject']);
    expect(validateCapability(record({ auditTrail: false }))).toEqual(['audit_required']);
    expect(validateCapability(record({ auditTrail: true }))).toEqual([]);
  });

  it('缺字段/非对象/坏证据 → 显式错误码', () => {
    expect(validateCapability(null)).toEqual(['record_must_be_object']);
    expect(validateCapability({})).toEqual(['missing_field:capabilityId']);
    expect(validateCapability(record({ evidence: [''] }))).toEqual(['bad_evidence']);
    expect(validateCapability(record({ evidence: 'not-list' }))).toEqual(['bad_evidence']);
  });
});
