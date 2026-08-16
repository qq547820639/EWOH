/* Canonical Maintenance / Quality 契约一致性测试（TS 侧，ADR-010 / NO-05a）。
 *
 * 与 tests/test_mq_contracts.py 消费同一份共享向量（contracts/{domain}/test-vectors.json），
 * 保证 Python/TS 语义逐项一致（§31）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MAINTENANCE_CONDITION_TYPES,
  MAINTENANCE_LIFECYCLE,
  maintenanceTransitionAllowed,
  validateMaintenanceCondition,
  isMaintenanceOverdue,
} from './maintenance';
import {
  QUALITY_DISPOSITIONS,
  QUALITY_FINDING_TYPES,
  QUALITY_LIFECYCLE,
  qualityTransitionAllowed,
  validateQualityFinding,
} from './quality';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function load(domain: string, name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'contracts', domain, name), 'utf-8'));
}

describe('canonical maintenance/quality contracts（共享向量，跨语言一致性）', () => {
  it('TS 锁定注册表与 schema 逐项一致', () => {
    const ms = load('maintenance', 'maintenance.schema.json') as { conditionTypeRegistry: string[]; lifecycle: string[] };
    expect([...MAINTENANCE_CONDITION_TYPES].sort()).toEqual([...ms.conditionTypeRegistry].sort());
    expect([...MAINTENANCE_LIFECYCLE]).toEqual(ms.lifecycle);
    const qs = load('quality', 'quality.schema.json') as {
      findingTypeRegistry: string[];
      lifecycle: string[];
      dispositionRegistry: string[];
    };
    expect([...QUALITY_FINDING_TYPES].sort()).toEqual([...qs.findingTypeRegistry].sort());
    expect([...QUALITY_LIFECYCLE]).toEqual(qs.lifecycle);
    expect([...QUALITY_DISPOSITIONS].sort()).toEqual([...qs.dispositionRegistry].sort());
  });

  it('maintenance conditions/transitions/overdue 向量逐项一致', () => {
    const vectors = load('maintenance', 'test-vectors.json') as {
      conditions: Array<{ name: string; record: unknown; expectError: string | null }>;
      transitions: Array<{ from: string; to: string; allowed: boolean }>;
      overdue: Array<{ name: string; dueAt: string | null; now: string; status: string; expect: boolean }>;
    };
    for (const c of vectors.conditions) {
      const errors = validateMaintenanceCondition(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
    }
    for (const c of vectors.transitions) {
      expect(maintenanceTransitionAllowed(c.from, c.to)).toBe(c.allowed);
    }
    for (const c of vectors.overdue) {
      expect(isMaintenanceOverdue(c.dueAt, c.status, c.now)).toBe(c.expect);
    }
  });

  it('quality findings/transitions 向量逐项一致', () => {
    const vectors = load('quality', 'test-vectors.json') as {
      findings: Array<{ name: string; record: unknown; expectError: string | null }>;
      transitions: Array<{ from: string; to: string; allowed: boolean }>;
    };
    for (const c of vectors.findings) {
      const errors = validateQualityFinding(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
    }
    for (const c of vectors.transitions) {
      expect(qualityTransitionAllowed(c.from, c.to)).toBe(c.allowed);
    }
  });
});
