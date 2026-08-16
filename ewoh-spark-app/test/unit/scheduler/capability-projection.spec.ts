/* capability-projection.spec.ts — Capability 契约消费方投影（NO-12u/ADR-044 + NO-12v/ADR-045）。 */
import {
  capabilityNames,
  deviceCapabilityNames,
  personCertificationExpiryMap,
  personSkillNames,
  projectDeviceCapabilities,
  projectPersonCapabilities,
  projectStationCapabilities,
  stationCapabilityNames,
} from '../../../server/modules/scheduler/capability-projection';

describe('projectPersonCapabilities（人员技能/认证 → CapabilityRecord）', () => {
  it('技能投影为 skill 记录（契约合法）', () => {
    const projection = projectPersonCapabilities({
      id: 'p1',
      skills: ['forklift', 'assembly'],
      certifications: [],
    });
    expect(projection.issues).toEqual([]);
    expect(projection.records).toHaveLength(2);
    expect(projection.records[0]).toMatchObject({
      kind: 'skill',
      name: 'forklift',
      providerType: 'person',
      subject: 'person:p1',
      auditTrail: true,
    });
  });

  it('认证有到期事实 + 无 issuer 数据源 → 显式缺口（绝不伪造 issuer，§33）', () => {
    const projection = projectPersonCapabilities({
      id: 'p1',
      skills: [],
      certifications: ['first_aid'],
      certificationExpiry: [{ name: 'first_aid', expiresAtMs: Date.parse('2027-08-01T00:00:00Z') }],
    });
    // 契约要求 certification issuer 非空；人员数据源无 issuer → 记录被契约门拒绝，
    // 投影以显式缺口码暴露（certification_missing_issuer）。
    expect(projection.records).toHaveLength(0);
    expect(projection.issues).toEqual(['certification_missing_issuer:first_aid']);
  });

  it('认证无到期事实 → certification_missing_expiry 显式缺口', () => {
    const projection = projectPersonCapabilities({
      id: 'p1',
      skills: [],
      certifications: ['first_aid'],
      certificationExpiry: [],
    });
    expect(projection.records).toHaveLength(0);
    expect(projection.issues).toEqual(['certification_missing_expiry:first_aid']);
  });

  it('空来源 → 空投影（显式空，不静默）', () => {
    const projection = projectPersonCapabilities({ id: 'p1', skills: [], certifications: [] });
    expect(projection).toEqual({ records: [], issues: [] });
  });
});

describe('projectDeviceCapabilities / projectStationCapabilities', () => {
  it('设备能力投影为 device_capability 记录', () => {
    const projection = projectDeviceCapabilities({
      id: 'exo-1',
      capabilities: ['exo-lift', 'vacuum'],
    });
    expect(projection.issues).toEqual([]);
    expect(projection.records.map((r) => [r.kind, r.name, r.providerType, r.subject])).toEqual([
      ['device_capability', 'exo-lift', 'device', 'device:exo-1'],
      ['device_capability', 'vacuum', 'device', 'device:exo-1'],
    ]);
  });

  it('工位能力投影为 station_capability 记录', () => {
    const projection = projectStationCapabilities({
      id: 's1',
      capabilities: ['assembly', 'inspection'],
    });
    expect(projection.records.map((r) => [r.kind, r.name, r.subject])).toEqual([
      ['station_capability', 'assembly', 'station:s1'],
      ['station_capability', 'inspection', 'station:s1'],
    ]);
  });

  it('capabilities 缺失 → 空投影（不猜测）', () => {
    expect(projectDeviceCapabilities({ id: 'd1' })).toEqual({ records: [], issues: [] });
    expect(projectStationCapabilities({ id: 's1' })).toEqual({ records: [], issues: [] });
  });

  it('非法能力名（空串）→ 契约门拒绝 + projection_invalid 显式缺口', () => {
    const projection = projectDeviceCapabilities({ id: 'd1', capabilities: [' '] });
    expect(projection.records).toHaveLength(0);
    expect(projection.issues).toHaveLength(1);
    expect(projection.issues[0]).toContain('projection_invalid:cap:device_capability:');
  });
});

describe('Record 化匹配收敛（NO-12v / ADR-045：语义不变纯结构收敛）', () => {
  it('personSkillNames：records 优先与 raw 回退语义逐字一致', () => {
    const source = { id: 'p1', skills: ['forklift', 'assembly'], certifications: [] };
    const records = projectPersonCapabilities(source).records;
    expect(personSkillNames({ ...source, capabilityRecords: records }))
      .toEqual(personSkillNames(source));
    expect(personSkillNames({ ...source, capabilityRecords: records }))
      .toEqual(['assembly', 'forklift']);
  });

  it('deviceCapabilityNames：records 优先与 raw 回退语义一致', () => {
    const source = { id: 'd1', capabilities: ['exo-lift', 'vacuum'] };
    const records = projectDeviceCapabilities(source).records;
    expect(deviceCapabilityNames({ ...source, capabilityRecords: records }))
      .toEqual(deviceCapabilityNames(source));
  });

  it('stationCapabilityNames：records 优先与 raw 回退语义一致', () => {
    const source = { id: 's1', capabilities: ['assembly', 'inspection'] };
    const records = projectStationCapabilities(source).records;
    expect(stationCapabilityNames(records, undefined))
      .toEqual(stationCapabilityNames(undefined, source.capabilities));
  });

  it('personCertificationExpiryMap：records 优先（expiresAt→ms）与 raw 回退语义一致', () => {
    const source = {
      id: 'p1',
      skills: [],
      certifications: ['first_aid'],
      // 数据源有 issuer 时投影出的 certification 记录带 expiresAt（模拟已补 issuer 的源投影）
    };
    const records = [
      {
        capabilityId: 'cap:certification:first_aid:person:p1',
        kind: 'certification',
        name: 'first_aid',
        providerType: 'person',
        subject: 'person:p1',
        expiresAt: '2027-08-01T00:00:00Z',
        issuer: 'org:x',
        evidence: [],
        auditTrail: true,
      },
    ];
    const fromRecords = personCertificationExpiryMap({ ...source, capabilityRecords: records });
    const fromRaw = personCertificationExpiryMap({
      ...source,
      certificationExpiry: [{ name: 'first_aid', expiresAtMs: Date.parse('2027-08-01T00:00:00Z') }],
    });
    expect(fromRecords.get('first_aid')).toBe(fromRaw.get('first_aid'));
    expect(fromRecords.get('first_aid')).toBe(Date.parse('2027-08-01T00:00:00Z'));
  });

  it('personCertificationExpiryMap：证书投影被契约缺口丢弃（无 issuer）→ 到期未知（与 raw 语义一致不视为过期）', () => {
    const source = {
      id: 'p1',
      skills: [],
      certifications: ['first_aid'],
      certificationExpiry: [{ name: 'first_aid', expiresAtMs: Date.parse('2027-08-01T00:00:00Z') }],
      capabilityRecords: [], // 投影缺口：无 issuer → 无 certification 记录
    };
    // 有 records（空）→ 该证书记录缺失 → 到期未知（null）；存在性仍由
    // person.certifications 判定（eligibility 语义：不视为过期）。
    expect(personCertificationExpiryMap(source).has('first_aid')).toBe(false);
  });

  it('capabilityNames：kind 过滤 + 去重有序', () => {
    const records = [
      { capabilityId: '1', kind: 'skill', name: 'b', providerType: 'person', subject: 'person:p1', auditTrail: true },
      { capabilityId: '2', kind: 'skill', name: 'a', providerType: 'person', subject: 'person:p1', auditTrail: true },
      { capabilityId: '3', kind: 'skill', name: 'b', providerType: 'person', subject: 'person:p1', auditTrail: true },
      { capabilityId: '4', kind: 'certification', name: 'c', providerType: 'person', subject: 'person:p1', expiresAt: '2027-08-01T00:00:00Z', issuer: 'org:x', auditTrail: true },
    ];
    expect(capabilityNames(records, 'skill')).toEqual(['a', 'b']);
    expect(capabilityNames(records, 'certification')).toEqual(['c']);
    expect(capabilityNames(undefined, 'skill')).toEqual([]);
  });
});
