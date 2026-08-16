/* EntityModel 契约行为测试（ADR-015 / NO-03a）。
 *
 * 覆盖：45 类实体注册表、双时态（validFrom 必填 / validTo 不得早于）、
 * tenant/factory 必填、来源三态（simulated 显式标记）、version ≥ 1、
 * confidence ∈ [0,1] 可选（缺省无标定）、refs/eventRefs 规范身份。
 * 共享向量由 scripts/audit-domain-contracts.js 独立仲裁（277/277，含
 * world-state 22 类快照 ⊆ 45 类注册表交叉校验）。
 */
/// <reference types="jest" />
import {
  validateEntityDeclaration,
  ENTITY_KINDS,
  ENTITY_SOURCES,
  WORLD_STATE_PROJECTABLE_KINDS,
  DEVICE_BUCKET_KINDS,
  isStateProjectable,
} from './entity-model';

const FAC = 'factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

const BASE: Record<string, unknown> = {
  entityId: 'machine:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  kind: 'machine',
  tenantId: 'org-1',
  factoryId: FAC,
  timeSemantics: { validFrom: '2026-08-16T08:00:00Z', validTo: null },
  status: 'idle',
  source: 'real',
  version: 1,
};

describe('entity-model contract', () => {
  it('合法声明：真实 person（refs/eventRefs）+ 模拟 machine（confidence）', () => {
    expect(
      validateEntityDeclaration({
        ...BASE,
        entityId: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
        kind: 'person',
        status: 'active',
        refs: ['station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
        eventRefs: ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
      }),
    ).toEqual([]);
    expect(
      validateEntityDeclaration({
        ...BASE,
        source: 'simulated',
        confidence: 0.9,
        timeSemantics: {
          validFrom: '2026-08-16T08:00:00Z',
          validTo: '2026-08-16T09:00:00Z',
        },
      }),
    ).toEqual([]);
  });

  it('注册表与来源：未知 kind/source 拒绝；模拟来源显式三态', () => {
    expect(validateEntityDeclaration({ ...BASE, kind: 'gizmo' })).toEqual([
      'unknown_kind',
    ]);
    expect(validateEntityDeclaration({ ...BASE, source: 'guessed' })).toEqual([
      'unknown_source',
    ]);
    expect(ENTITY_SOURCES).toEqual(['real', 'simulated', 'derived']);
    expect(ENTITY_KINDS).toHaveLength(45);
    expect(ENTITY_KINDS).toContain('exo');
    expect(ENTITY_KINDS).toContain('quality_finding');
    expect(ENTITY_KINDS).toContain('knowledge');
  });

  it('双时态：validFrom 必填 / validTo 不得早于 validFrom', () => {
    expect(
      validateEntityDeclaration({
        ...BASE,
        timeSemantics: { validFrom: '2026-08-16T09:00:00Z', validTo: '2026-08-16T08:00:00Z' },
      }),
    ).toEqual(['bad_time']);
    expect(
      validateEntityDeclaration({ ...BASE, timeSemantics: { validFrom: 'not-a-time' } }),
    ).toEqual(['bad_time']);
  });

  it('tenant/factory 必填、version ≥ 1', () => {
    expect(validateEntityDeclaration({ ...BASE, tenantId: '' })).toEqual(['bad_tenant']);
    expect(validateEntityDeclaration({ ...BASE, factoryId: '' })).toEqual(['bad_factory']);
    expect(validateEntityDeclaration({ ...BASE, version: 0 })).toEqual(['bad_version']);
  });

  it('confidence ∈ [0,1] 可选；refs 规范身份强制', () => {
    expect(validateEntityDeclaration({ ...BASE, confidence: 1.7 })).toEqual([
      'bad_confidence',
    ]);
    expect(
      validateEntityDeclaration({ ...BASE, refs: ['not-canonical'] }),
    ).toEqual(['bad_ref']);
  });

  it('kind 前缀一致性（ADR-015 投影分工）：前缀 ≠ kind 拒绝', () => {
    expect(validateEntityDeclaration({ ...BASE, kind: 'station' })).toEqual([
      'kind_prefix_mismatch',
    ]);
    expect(
      validateEntityDeclaration({
        ...BASE,
        entityId: 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
        kind: 'machine',
      }),
    ).toEqual(['kind_prefix_unknown']);
    expect(
      validateEntityDeclaration({
        ...BASE,
        entityId: 'exo:NY-A1-SN-0007',
        kind: 'exo',
      }),
    ).toEqual([]);
  });

  it('投影分工注册表：22 类可状态投影 + 云侧 device 桶显式映射', () => {
    expect(WORLD_STATE_PROJECTABLE_KINDS).toHaveLength(22);
    expect(isStateProjectable('person')).toBe(true);
    expect(isStateProjectable('skill')).toBe(false);
    expect(isStateProjectable('worker_capability')).toBe(false);
    expect(DEVICE_BUCKET_KINDS).toEqual([
      'device',
      'exo',
      'machine',
      'robot',
      'agv',
      'sensor',
    ]);
  });
});
