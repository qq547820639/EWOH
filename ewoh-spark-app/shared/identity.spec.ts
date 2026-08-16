/* Canonical Identity 契约一致性测试（TS 侧，ADR-006 / Phase 2 NO-02）。
 *
 * 与 tests/test_identity_contract.py 消费同一份共享向量
 * （contracts/identity/test-vectors.json），保证 Python/TS 语义逐项一致
 * （总提示词 §31：跨运行时共享 Test Vector）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  IDENTITY_KINDS,
  IdentityConflictError,
  IdentityError,
  formatIdentity,
  isCanonicalIdentity,
  kindOf,
  parseIdentity,
  resolveIdentityMapping,
  validateMappingRecord,
  valueOf,
} from './identity';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VECTORS_PATH = path.join(REPO_ROOT, 'contracts', 'identity', 'test-vectors.json');
const SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'identity', 'identity.schema.json');

interface Vectors {
  schemaVersion: string;
  valid: string[];
  invalid: Array<{ value: string; reason: string }>;
  mappingScenarios: Array<{
    name: string;
    system: string;
    sourceId: string;
    now: string;
    mappings: unknown[];
    expect: string | null;
    expectError: string | null;
  }>;
}

const vectors: Vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf-8'));
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

describe('canonical identity contract（共享向量，跨语言一致性）', () => {
  it('TS 锁定注册表与 schema.kindRegistry 逐项一致', () => {
    expect([...IDENTITY_KINDS].sort()).toEqual([...schema.kindRegistry].sort());
  });

  it('valid 向量全部可解析且 round-trip 稳定', () => {
    for (const value of vectors.valid) {
      const { kind, value: v } = parseIdentity(value);
      expect(formatIdentity(kind, v)).toBe(value);
      expect(isCanonicalIdentity(value)).toBe(true);
    }
  });

  it('invalid 向量全部被拒绝（fail-closed）', () => {
    for (const entry of vectors.invalid) {
      expect(isCanonicalIdentity(entry.value)).toBe(false);
      expect(() => parseIdentity(entry.value)).toThrow(IdentityError);
    }
  });

  it('mapping 场景与声明结果逐项一致', () => {
    for (const scenario of vectors.mappingScenarios) {
      if (scenario.expectError != null) {
        try {
          resolveIdentityMapping(scenario.system, scenario.sourceId, scenario.mappings, scenario.now);
          fail(`场景 ${scenario.name} 应抛 ${scenario.expectError}`);
        } catch (err) {
          expect(err).toBeInstanceOf(IdentityConflictError);
          expect((err as IdentityError).code).toBe(scenario.expectError);
        }
      } else {
        const result = resolveIdentityMapping(
          scenario.system,
          scenario.sourceId,
          scenario.mappings,
          scenario.now,
        );
        expect(result).toBe(scenario.expect);
      }
    }
  });
});

describe('identity primitives', () => {
  it('parseIdentity 返回 kind/value', () => {
    expect(parseIdentity('person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11')).toEqual({
      kind: 'person',
      value: '9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    });
    expect(kindOf('exo:NY-A1-SN-0007')).toBe('exo');
    expect(valueOf('exo:NY-A1-SN-0007')).toBe('NY-A1-SN-0007');
  });

  it('formatIdentity 拒绝非法输入', () => {
    try {
      formatIdentity('unknownkind' as never, 'x');
      fail('应拒绝未知 kind');
    } catch (err) {
      expect((err as IdentityError).code).toBe('unknown_kind');
    }
    try {
      formatIdentity('person', 'a/b');
      fail('应拒绝非法 value');
    } catch (err) {
      expect((err as IdentityError).code).toBe('bad_value');
    }
  });

  it('parseIdentity fail-closed 变体', () => {
    const cases: Array<[string, string]> = [
      ['', 'bad_canonical_form'],
      [':x', 'unknown_kind'],
      ['person:', 'bad_value'],
      ['person:a:b', 'bad_canonical_form'],
      ['Person:x', 'unknown_kind'],
      ['person:x%20y', 'bad_value'],
    ];
    for (const [input, code] of cases) {
      try {
        parseIdentity(input);
        fail(`${JSON.stringify(input)} 应拒绝`);
      } catch (err) {
        expect((err as IdentityError).code).toBe(code);
      }
    }
  });

  it('isCanonicalIdentity 不抛异常', () => {
    expect(isCanonicalIdentity('factory:f1')).toBe(true);
    expect(isCanonicalIdentity('nope')).toBe(false);
    expect(isCanonicalIdentity(null)).toBe(false);
  });
});

describe('identity mapping semantics', () => {
  const baseRecord = {
    mappingId: 'map:m1',
    version: 1,
    source: { system: 'mes', id: 'WO-1' },
    target: { entityId: 'order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11' },
    authority: 'registration' as const,
    status: 'active' as const,
    recordedAt: '2026-08-14T08:00:00Z',
    validFrom: null,
    validTo: null,
    evidenceId: null,
  };

  it('重复登记同目标幂等解析', () => {
    const dup = { ...baseRecord, mappingId: 'map:m2' };
    expect(resolveIdentityMapping('mes', 'WO-1', [baseRecord, dup], '2026-08-14T10:00:00Z')).toBe(
      'order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    );
  });

  it('冲突目标 fail-closed 抛 ambiguous_identity', () => {
    const other = {
      ...baseRecord,
      mappingId: 'map:m2',
      target: { entityId: 'order:00000000-0000-4000-8000-000000000002' },
    };
    expect(() =>
      resolveIdentityMapping('mes', 'WO-1', [baseRecord, other], '2026-08-14T10:00:00Z'),
    ).toThrow(IdentityConflictError);
  });

  it('形状非法记录被跳过而非信任', () => {
    expect(resolveIdentityMapping('mes', 'WO-1', [{ junk: true }])).toBeNull();
  });
});

describe('mapping record validation（TS）', () => {
  it('合法记录零错误', () => {
    const record = {
      mappingId: 'map:m1',
      version: 1,
      source: { system: 'mes', id: 'WO-1001' },
      target: { entityId: 'order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11' },
      authority: 'registration',
      status: 'active',
      recordedAt: '2026-08-14T08:00:00Z',
      validFrom: null,
      validTo: null,
      evidenceId: null,
    };
    expect(validateMappingRecord(record)).toEqual([]);
  });

  it('畸形记录报错列表', () => {
    expect(validateMappingRecord('not-a-dict')).toEqual(['record_must_be_object']);
    expect(validateMappingRecord({ mappingId: 'map:x', version: 1 })).toContain('missing_field:target');
    const badTarget = {
      mappingId: 'map:m1',
      version: 1,
      source: { system: 'mes', id: 'WO-1' },
      target: { entityId: 'not-canonical' },
      authority: 'registration',
      status: 'active',
      recordedAt: '2026-08-14T08:00:00Z',
    };
    expect(validateMappingRecord(badTarget)).toContain('bad_target_entity_id');
  });
});
