/* Knowledge Entry 契约行为测试（ADR-018 / NO-07，Factory Knowledge System 立项）。
 *
 * 覆盖：6 kind / 5 层 scope（有序阶梯）/ 3 status 封闭注册表、证据链非空
 * 可追溯、五层租户语义（customer/factory/private_operational 必填 tenantId；
 * global/industry 禁止 tenantId）、provenance 声明（global/industry 必填、
 * private_operational 禁止）、双时态、auditTrail 强制。
 * 共享向量由 scripts/audit-domain-contracts.js knowledge 域独立仲裁（374/374）。
 */
/// <reference types="jest" />
import {
  validateKnowledgeEntry,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SCOPES,
} from './knowledge-entry';

const KID = 'knowledge:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

const BASE: Record<string, unknown> = {
  knowledgeId: KID,
  kind: 'incident',
  scope: 'factory',
  tenantId: 'org-1',
  title: '工位 A 线边缺料处置记录',
  summary: '线边缺料导致停线的处置过程与根因',
  body: '缺料根因为 AGV 调度拥塞；处置为临时补员 + 调整补料窗口。',
  sourceEvidenceIds: ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
  relatedEntityIds: ['station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
  tags: ['缺料', 'AGV'],
  version: 1,
  status: 'verified',
  timeSemantics: { validFrom: '2026-08-16T08:00:00Z', validTo: null },
  auditTrail: true,
};

describe('knowledge-entry contract', () => {
  it('合法工厂事件知识 + 全局失败模式（provenance 声明）通过', () => {
    expect(validateKnowledgeEntry(BASE)).toEqual([]);
    expect(
      validateKnowledgeEntry({
        ...BASE,
        knowledgeId: 'knowledge:5c1b2a3d-1111-4222-8333-9a8b7c6d5e4f',
        kind: 'failure_pattern',
        scope: 'global',
        tenantId: undefined,
        provenance: {
          trainingDataSources: ['anonymized-aggregates-2026H1'],
          anonymizationPolicy: 'k-anonymity>=5',
          dataAuthorization: 'opt-in-2026-01',
          modelVersion: 'pattern-v2',
        },
        status: 'verified',
      }),
    ).toEqual([]);
  });

  it('注册表：6 kind / 5 层 scope 阶梯 / 3 status', () => {
    expect(KNOWLEDGE_KINDS).toHaveLength(6);
    expect(KNOWLEDGE_SCOPES).toEqual([
      'global', 'industry', 'customer', 'factory', 'private_operational',
    ]);
    expect(validateKnowledgeEntry({ ...BASE, kind: 'gizmo' })).toEqual(['unknown_kind']);
    expect(validateKnowledgeEntry({ ...BASE, scope: 'galactic' })).toEqual(['unknown_scope']);
    expect(validateKnowledgeEntry({ ...BASE, status: 'published' })).toEqual(['bad_status']);
  });

  it('五层租户语义：租户内必填 / 共享层禁止 tenantId', () => {
    expect(validateKnowledgeEntry({ ...BASE, tenantId: undefined })).toEqual(['tenant_required']);
    expect(
      validateKnowledgeEntry({
        ...BASE,
        scope: 'global',
        tenantId: 'org-1',
        provenance: {
          trainingDataSources: ['a'],
          anonymizationPolicy: 'p',
          dataAuthorization: 'd',
          modelVersion: 'v1',
        },
      }),
    ).toEqual(['tenant_forbidden']);
  });

  it('provenance：global/industry 必填、private_operational 禁止', () => {
    expect(validateKnowledgeEntry({ ...BASE, scope: 'global', tenantId: undefined })).toEqual([
      'provenance_required',
    ]);
    expect(
      validateKnowledgeEntry({
        ...BASE,
        scope: 'private_operational',
        provenance: {
          trainingDataSources: ['a'],
          anonymizationPolicy: 'p',
          dataAuthorization: 'd',
          modelVersion: 'v1',
        },
      }),
    ).toEqual(['provenance_forbidden']);
  });

  it('证据链：sourceEvidenceIds 非空且规范身份（§3 可追溯）', () => {
    expect(validateKnowledgeEntry({ ...BASE, sourceEvidenceIds: [] })).toEqual([
      'empty_evidence',
    ]);
    expect(validateKnowledgeEntry({ ...BASE, sourceEvidenceIds: ['not-canonical'] })).toEqual([
      'bad_evidence_ref',
    ]);
  });

  it('auditTrail 强制 + 双时态', () => {
    expect(validateKnowledgeEntry({ ...BASE, auditTrail: false })).toEqual(['audit_required']);
    expect(
      validateKnowledgeEntry({
        ...BASE,
        timeSemantics: { validFrom: '2026-08-16T09:00:00Z', validTo: '2026-08-16T08:00:00Z' },
      }),
    ).toEqual(['bad_time']);
  });
});
