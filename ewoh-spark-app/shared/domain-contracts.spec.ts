/* Canonical Risk/Location/Resource 契约一致性测试（TS 侧，ADR-007 / NO-02c）。
 *
 * 与 tests/test_domain_contracts.py 消费同一份共享向量（contracts/{domain}/test-vectors.json），
 * 保证 Python/TS 语义逐项一致（总提示词 §31：跨运行时共享 Test Vector）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  RISK_SEVERITY_LADDER,
  RISK_LIFECYCLE,
  RISK_CATEGORIES,
  RISK_LEGACY_SEVERITY_MAP,
  DomainContractError,
  normalizeSeverity,
  severityHigherThan,
  riskTransitionAllowed,
  isValidRiskCategory,
} from './risk';
import { SPATIAL_KINDS, COORDINATE_TYPES, validateLocationRecord } from './location';
import {
  RESOURCE_STATUSES,
  RESOURCE_DATA_QUALITIES,
  RESOURCE_SOURCES,
  RESOURCE_TYPES,
  evaluateAvailability,
  isResourceStatus,
  isResourceType,
} from './resource';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadVectors(domain: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts', domain, 'test-vectors.json'), 'utf-8'),
  );
}

function loadSchema(domain: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts', domain, `${domain}.schema.json`), 'utf-8'),
  );
}

describe('canonical domain contracts（共享向量，跨语言一致性）', () => {
  it('TS 锁定注册表与 schema 逐项一致', () => {
    const riskSchema = loadSchema('risk') as { severityLadder: string[]; legacySeverityMap: Record<string, string>; lifecycle: string[]; categoryRegistry: string[] };
    expect([...RISK_SEVERITY_LADDER]).toEqual(riskSchema.severityLadder);
    expect(RISK_LEGACY_SEVERITY_MAP).toEqual(riskSchema.legacySeverityMap);
    expect([...RISK_LIFECYCLE]).toEqual(riskSchema.lifecycle);
    expect([...RISK_CATEGORIES].sort()).toEqual([...riskSchema.categoryRegistry].sort());

    const locSchema = loadSchema('location') as { spatialKindRegistry: string[]; coordinateTypes: string[] };
    expect([...SPATIAL_KINDS].sort()).toEqual([...locSchema.spatialKindRegistry].sort());
    expect([...COORDINATE_TYPES]).toEqual(locSchema.coordinateTypes);

    const resSchema = loadSchema('resource') as { statusRegistry: string[]; dataQualityRegistry: string[]; sourceRegistry: string[]; resourceTypeRegistry: string[] };
    expect([...RESOURCE_STATUSES]).toEqual(resSchema.statusRegistry);
    expect([...RESOURCE_DATA_QUALITIES]).toEqual(resSchema.dataQualityRegistry);
    expect([...RESOURCE_SOURCES]).toEqual(resSchema.sourceRegistry);
    expect([...RESOURCE_TYPES]).toEqual(resSchema.resourceTypeRegistry);
  });

  it('risk severityNormalize 向量逐项一致', () => {
    const vectors = loadVectors('risk') as { severityNormalize: Array<{ input: string; expect?: string; expectError?: string }> };
    for (const case_ of vectors.severityNormalize) {
      if (case_.expectError != null) {
        try {
          normalizeSeverity(case_.input);
          fail(`应拒绝 ${case_.input}`);
        } catch (err) {
          expect((err as DomainContractError).code).toBe(case_.expectError);
        }
      } else {
        expect(normalizeSeverity(case_.input)).toBe(case_.expect);
      }
    }
  });

  it('risk severityOrder / transitions / categories 向量逐项一致', () => {
    const vectors = loadVectors('risk') as {
      severityOrder: Array<{ higher: string; lower: string }>;
      transitions: Array<{ from: string; to: string; allowed: boolean }>;
      categories: Array<{ value: string; valid: boolean }>;
    };
    for (const case_ of vectors.severityOrder) {
      expect(severityHigherThan(case_.higher, case_.lower)).toBe(true);
    }
    for (const case_ of vectors.transitions) {
      expect(riskTransitionAllowed(case_.from, case_.to)).toBe(case_.allowed);
    }
    for (const case_ of vectors.categories) {
      expect(isValidRiskCategory(case_.value)).toBe(case_.valid);
    }
  });

  it('location spatialKinds / records 向量逐项一致', () => {
    const vectors = loadVectors('location') as {
      spatialKinds: Array<{ value: string; valid: boolean }>;
      records: Array<{ name: string; record: unknown; expectError: string | null }>;
    };
    for (const case_ of vectors.spatialKinds) {
      expect(SPATIAL_KINDS.includes(case_.value as never)).toBe(case_.valid);
    }
    for (const case_ of vectors.records) {
      const errors = validateLocationRecord(case_.record);
      if (case_.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors).toContain(case_.expectError);
      }
    }
  });

  it('resource statuses / availability / resourceTypes 向量逐项一致', () => {
    const vectors = loadVectors('resource') as {
      statuses: Array<{ value: string; valid: boolean }>;
      availability: Array<{ name: string; status: string; dataQuality: string; expect?: { available: boolean; reason: string | null }; expectError?: string }>;
      resourceTypes: Array<{ value: string; valid: boolean }>;
    };
    for (const case_ of vectors.statuses) {
      expect(isResourceStatus(case_.value)).toBe(case_.valid);
    }
    for (const case_ of vectors.availability) {
      if (case_.expectError != null) {
        try {
          evaluateAvailability(case_.status, case_.dataQuality);
          fail(`应拒绝 ${case_.status}`);
        } catch (err) {
          expect((err as DomainContractError).code).toBe(case_.expectError);
        }
      } else {
        expect(evaluateAvailability(case_.status, case_.dataQuality)).toEqual(case_.expect);
      }
    }
    for (const case_ of vectors.resourceTypes) {
      expect(isResourceType(case_.value)).toBe(case_.valid);
    }
  });
});
