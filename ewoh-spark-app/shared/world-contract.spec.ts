/* Canonical World State 契约一致性测试（TS 侧，ADR-008 / NO-03）。
 *
 * 与 tests/test_world_contract.py 消费同一份共享向量（contracts/world/test-vectors.json），
 * 保证 Python/TS 语义逐项一致（§31）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  WORLD_ENTITY_TYPES,
  WORLD_SOURCE_TYPES,
  validateCloudWorldSnapshot,
  validateWorldStateRecord,
  validateWorldIntervalSet,
  validateWorldSnapshot,
  worldSnapshotSourceProfile,
} from './world-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadVectors(): {
  schemaVersion: string;
  stateRecords: Array<{ name: string; record: unknown; expectError: string | null }>;
  transitions: Array<{
    name: string;
    entityId: string;
    stateType: string;
    states: Array<{ validFrom: string; validTo: string | null; version: number }>;
    expect: { valid: boolean; currentVersion?: number; reason?: string; previousClosedAt?: string | null };
  }>;
  snapshots: Array<{
    name: string;
    snapshot: Record<string, unknown>;
    expect?: { simulatedOnly: boolean; hasReal: boolean } | null;
    expectError: string | null;
  }>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'world', 'test-vectors.json'), 'utf-8'),
  );
}

describe('validateCloudWorldSnapshot（NO-03b：云侧快照构建自检）', () => {
  const good = {
    worldVersion: 42,
    entityVersions: { 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11': 3 },
    persons: [{ entityId: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11' }],
    devices: [{ entityId: 'device:d1' }],
    stations: [{ entityId: 'station:s1' }],
    tasks: [{ entityId: 'task:t1' }],
  };
  it('合法快照零错误', () => {
    expect(validateCloudWorldSnapshot(good)).toEqual([]);
  });
  it('entityVersions 非规范键被检出', () => {
    expect(
      validateCloudWorldSnapshot({ ...good, entityVersions: { p1: 1 } }),
    ).toContain('bad_entity_version_key');
  });
  it('实体规范引用 kind 不匹配被检出', () => {
    expect(
      validateCloudWorldSnapshot({
        ...good,
        persons: [{ entityId: 'device:d1' }],
      }),
    ).toContain('bad_entity_ref_kind');
  });
  it('device 桶（ADR-015 projectionBuckets）：设备类实体 kind 与遗留 device 身份桶均合法', () => {
    expect(
      validateCloudWorldSnapshot({
        ...good,
        devices: [
          { entityId: 'exo:NY-A1-SN-0007' },
          { entityId: 'machine:m1' },
          { entityId: 'robot:r1' },
          { entityId: 'agv:a1' },
          { entityId: 'sensor:s1' },
        ],
      }),
    ).toEqual([]);
  });
  it('device 桶负例：person kind 落入 device 桶被检出', () => {
    expect(
      validateCloudWorldSnapshot({
        ...good,
        devices: [{ entityId: 'person:p1' }],
      }),
    ).toContain('bad_entity_ref_kind');
  });
  it('worldVersion 非法被检出', () => {
    expect(validateCloudWorldSnapshot({ ...good, worldVersion: -1 })).toContain('bad_world_version');
  });
});

describe('canonical world state contract（共享向量，跨语言一致性）', () => {
  it('TS 锁定注册表与 schema 逐项一致', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'world', 'world-state.schema.json'), 'utf-8'),
    );
    expect([...WORLD_ENTITY_TYPES].sort()).toEqual([...schema.entityTypeRegistry].sort());
    expect([...WORLD_SOURCE_TYPES].sort()).toEqual([...schema.sourceTypeRegistry].sort());
  });

  it('stateRecords 向量逐项一致', () => {
    for (const c of loadVectors().stateRecords) {
      const errors = validateWorldStateRecord(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
    }
  });

  it('transitions 向量逐项一致', () => {
    for (const c of loadVectors().transitions) {
      const records = c.states.map((st) => ({
        entityId: c.entityId,
        stateType: c.stateType,
        validFrom: st.validFrom,
        validTo: st.validTo,
        version: st.version,
      }));
      const errors = validateWorldIntervalSet(records);
      if (c.expect.valid) {
        expect(errors).toEqual([]);
        if (c.expect.currentVersion != null) {
          const current = records.filter((r) => r.validTo == null);
          expect(current[0].version).toBe(c.expect.currentVersion);
        }
      } else {
        expect(errors).toContain(c.expect.reason);
      }
    }
  });

  it('stateType partitions intervals; entityType is the explicit fallback', () => {
    const base = {
      stateId: 'STS-state-type',
      entityId: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
      stateJson: {},
      validFrom: '2026-08-14T08:00:00Z',
      validTo: null,
      sourceType: 'real',
      confidence: 1,
      version: 1,
    };
    expect(validateWorldIntervalSet([
      { ...base, stateType: 'location', validTo: '2026-08-14T09:00:00Z' },
      { ...base, stateType: 'battery', version: 2, validFrom: '2026-08-14T08:30:00Z' },
    ])).toEqual([]);
    expect(validateWorldIntervalSet([
      { ...base, validTo: '2026-08-14T09:00:00Z' },
      { ...base, entityType: 'exo', validFrom: '2026-08-14T08:30:00Z' },
    ])).toEqual([]);
  });

  it('snapshots 向量逐项一致', () => {
    for (const c of loadVectors().snapshots) {
      const errors = validateWorldSnapshot(c.snapshot);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
        if (c.expect != null) {
          expect(worldSnapshotSourceProfile(c.snapshot.states as unknown[])).toEqual(c.expect);
        }
      } else {
        expect(errors).toContain(c.expectError);
      }
    }
  });
});
