/* KnowledgeService 契约行为测试（ADR-018 Amendment 1 / NO-07b）。
 *
 * 覆盖：契约校验 fail-closed（未知 kind / global 无 provenance / 跨租户注册）、
 * 共享层条目落哨兵 org、租户层条目落调用租户 org、创建幂等（唯一键冲突回读
 * 不重发事件）、KnowledgeEntryCreated 事件落库、检索五层阶梯（共享层 ∪ 本租户层，
 * 他租户行不可见）、共享检索 fail-closed（绝不越过 global/industry）、状态转移
 * （draft→verified 必须 verifiedBy / superseded 终态 / 共享层只读）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_039 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { KnowledgeService, PLATFORM_SHARED_ORG_ID } from '../knowledge.service';
import { ewohKnowledgeEntry, ewohEvent } from '@server/database/schema';

const ORG_A = '11111111-2222-4333-8444-555555555555';
const ORG_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SENTINEL = PLATFORM_SHARED_ORG_ID;

const KNOWN_SCOPES = ['global', 'industry', 'customer', 'factory', 'private_operational'];
const KNOWN_STATUSES = ['draft', 'verified', 'superseded'];
const KNOWN_KINDS = ['incident', 'resolution', 'failure_pattern', 'process_knowledge', 'decision_history', 'evidence'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const VALID_INPUT = {
  knowledgeId: 'knowledge:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  kind: 'process_knowledge',
  scope: 'factory',
  title: '线边缺料处置要点',
  summary: '缺料触发换线流程的标准处置',
  body: '检测到线边缺料后，先冻结对应工位派工，再触发补料任务。',
  sourceEvidenceIds: ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
  relatedEntityIds: ['station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
  tags: ['缺料', '换线'],
};

const SHARED_INPUT = {
  knowledgeId: 'knowledge:shared-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  kind: 'failure_pattern',
  scope: 'global',
  title: 'AGV 减速带震动模式库',
  summary: '跨工厂共享的 AGV 故障模式',
  body: '减速带通过时纵向震动频谱超过阈值通常指向减震垫老化。',
  sourceEvidenceIds: ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
  tags: ['agv'],
  provenance: {
    trainingDataSources: ['ewoh-aggregated-anonymized'],
    anonymizationPolicy: 'k-anonymity-v2',
    dataAuthorization: 'customer-consented',
    modelVersion: 'agv-pattern-1.0',
  },
};

function collectValues(
  node: unknown,
  sets: { entryIds: Set<string>; orgIds: Set<string>; scopes: Set<string>; statuses: Set<string>; kinds: Set<string> },
  seen: WeakSet<object>,
): void {
  if (node == null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (Array.isArray(node)) {
    for (const x of node) collectValues(x, sets, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value' && typeof value === 'string') {
      if (value.startsWith('knowledge:')) sets.entryIds.add(value);
      if (UUID_RE.test(value)) sets.orgIds.add(value);
      if (KNOWN_SCOPES.includes(value)) sets.scopes.add(value);
      if (KNOWN_STATUSES.includes(value)) sets.statuses.add(value);
      if (KNOWN_KINDS.includes(value)) sets.kinds.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function collectSets(cond: unknown) {
  const sets = {
    entryIds: new Set<string>(),
    orgIds: new Set<string>(),
    scopes: new Set<string>(),
    statuses: new Set<string>(),
    kinds: new Set<string>(),
  };
  collectValues(cond, sets, new WeakSet());
  return sets;
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = collectSets(cond);
  if (sets.entryIds.size > 0 && !sets.entryIds.has(String(row.entryId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.scopes.size > 0 && !sets.scopes.has(String(row.scope))) return false;
  if (sets.statuses.size > 0 && !sets.statuses.has(String(row.status))) return false;
  if (sets.kinds.size > 0 && !sets.kinds.has(String(row.kind))) return false;
  return true;
}

function rowOf(
  entryId: string,
  scope: string,
  orgId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId,
    entryId,
    baseId: null,
    title: 't',
    summary: 's',
    body: 'b',
    tags: [],
    kind: 'process_knowledge',
    scope,
    status: 'draft',
    version: 1,
    sourceEvidenceIds: ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
    relatedEntityIds: [],
    provenance: null,
    verifiedBy: null,
    validFrom: new Date('2026-08-16T08:00:00Z'),
    validTo: null,
    auditTrail: true,
    legacyWithoutEvidence: false,
    ...overrides,
  };
}

function createKnowledgeDb(
  presetRows: Array<Record<string, unknown>> = [],
  options: { onWhere?: (cond: unknown) => void } = {},
) {
  const rows: Array<Record<string, unknown>> = [...presetRows];
  const events: Array<Record<string, unknown>> = [];
  let nextInsertError: unknown = null;
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => {
          options.onWhere?.(cond);
          return thenable(rows.filter((r) => matches(cond, r)));
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (nextInsertError) {
          const err = nextInsertError;
          nextInsertError = null;
          throw err;
        }
        if (table === ewohKnowledgeEntry) rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) =>
          Promise.resolve(
            table === ewohKnowledgeEntry ? rows.filter((r) => matches(cond, r)).map((r) => Object.assign(r, patch)) : [],
          ),
        ),
      })),
    })),
    __failNextInsertWith: (err: unknown) => {
      nextInsertError = err;
    },
  };
  const service = new KnowledgeService(db as never);
  return { db, rows, events, service };
}

describe('KnowledgeService（NO-07b 知识运行时）', () => {
  it('注册 fail-closed：未知 kind 拒绝且不落库', async () => {
    const { rows, service } = createKnowledgeDb();
    await expect(
      service.registerEntry({ ...VALID_INPUT, kind: 'gizmo' }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('注册 fail-closed：global 无 provenance 拒绝（§15/§16 共享政策）', async () => {
    const { rows, service } = createKnowledgeDb();
    await expect(
      service.registerEntry({ ...SHARED_INPUT, provenance: undefined }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('注册 fail-closed：跨租户注册显式拒绝（tenantId ≠ 调用租户）', async () => {
    const { rows, service } = createKnowledgeDb();
    await expect(
      service.registerEntry({ ...VALID_INPUT, tenantId: ORG_B }, ORG_A),
    ).rejects.toThrow('cross_tenant_register_forbidden');
    expect(rows).toHaveLength(0);
  });

  it('租户层条目落调用租户 org + KnowledgeEntryCreated 事件', async () => {
    const { rows, events, service } = createKnowledgeDb();
    const result = await service.registerEntry(VALID_INPUT, ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(ORG_A);
    expect(rows[0]?.scope).toBe('factory');
    expect(result.created).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('KnowledgeEntryCreated');
  });

  it('共享层条目落哨兵 org（Amendment 1 决策 2）', async () => {
    const { rows, service } = createKnowledgeDb();
    await service.registerEntry(SHARED_INPUT, ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(SENTINEL);
    expect(rows[0]?.scope).toBe('global');
  });

  it('创建幂等：唯一键冲突回读既有行且不重发事件', async () => {
    const existing = rowOf(VALID_INPUT.knowledgeId, 'factory', ORG_A);
    const { db, events, service } = createKnowledgeDb([existing]);
    db.__failNextInsertWith({ code: '23505' });
    const result = await service.registerEntry(VALID_INPUT, ORG_A);
    expect(result.created).toBe(false);
    expect(result.record?.knowledgeId).toBe(VALID_INPUT.knowledgeId);
    expect(events).toHaveLength(0);
  });

  it('检索五层阶梯：共享层 + 本租户层可见，他租户行不可见', async () => {
    const sharedRow = rowOf('knowledge:shared-1', 'global', SENTINEL);
    const industryRow = rowOf('knowledge:shared-2', 'industry', SENTINEL);
    const customerRow = rowOf('knowledge:own-1', 'customer', ORG_A);
    const privateRow = rowOf('knowledge:own-2', 'private_operational', ORG_A);
    const otherTenantRow = rowOf('knowledge:other-1', 'factory', ORG_B);
    const { service } = createKnowledgeDb([sharedRow, industryRow, customerRow, privateRow, otherTenantRow]);
    const entries = await service.retrieveEntries(ORG_A);
    const ids = entries.map((e) => e.knowledgeId);
    expect(ids).toContain('knowledge:shared-1');
    expect(ids).toContain('knowledge:shared-2');
    expect(ids).toContain('knowledge:own-1');
    expect(ids).toContain('knowledge:own-2');
    expect(ids).not.toContain('knowledge:other-1');
    expect(ids).toHaveLength(4);
  });

  it('检索阶梯：scope/kind/status 过滤与阶梯双支进入查询条件', async () => {
    const conditions: unknown[] = [];
    const { service } = createKnowledgeDb([], { onWhere: (c) => conditions.push(c) });
    await service.retrieveEntries(ORG_A, { scope: 'global', kind: 'incident', status: 'verified' });
    const sets = collectSets(conditions[0]);
    // 显式过滤进入查询条件
    expect(sets.scopes.has('global')).toBe(true);
    expect(sets.kinds.has('incident')).toBe(true);
    expect(sets.statuses.has('verified')).toBe(true);
    // 可见谓词 = 共享层哨兵 org 支 + 调用租户 org 支（五层阶梯双支）
    expect(sets.orgIds.has(SENTINEL)).toBe(true);
    expect(sets.orgIds.has(ORG_A)).toBe(true);
    expect(sets.orgIds.has(ORG_B)).toBe(false);
  });

  it('共享检索：仅 global/industry；租户层 scope 过滤 fail-closed 拒绝', async () => {
    const sharedRow = rowOf('knowledge:shared-1', 'global', SENTINEL);
    const factoryRow = rowOf('knowledge:own-1', 'factory', ORG_A);
    const { service } = createKnowledgeDb([sharedRow, factoryRow]);
    const shared = await service.retrieveSharedEntries();
    expect(shared.map((e) => e.knowledgeId)).toEqual(['knowledge:shared-1']);
    await expect(
      service.retrieveSharedEntries({ scope: 'private_operational' }),
    ).rejects.toThrow('shared_scope_only');
  });

  it('getEntry 越界返回 null（他租户行对调用租户不可见）', async () => {
    const otherTenantRow = rowOf('knowledge:other-1', 'factory', ORG_B);
    const { service } = createKnowledgeDb([otherTenantRow]);
    const entry = await service.getEntry(ORG_A, 'knowledge:other-1');
    expect(entry).toBeNull();
  });

  it('转移：draft→verified 缺 verifiedBy 拒绝', async () => {
    const own = rowOf('knowledge:own-1', 'factory', ORG_A);
    const { service } = createKnowledgeDb([own]);
    await expect(
      service.transitionStatus(ORG_A, 'knowledge:own-1', { to: 'verified' }),
    ).rejects.toThrow('verifiedBy');
  });

  it('转移：draft→verified 需规范身份 verifiedBy；superseded 终态', async () => {
    const own = rowOf('knowledge:own-1', 'factory', ORG_A);
    const { rows, service } = createKnowledgeDb([own]);
    await expect(
      service.transitionStatus(ORG_A, 'knowledge:own-1', { to: 'verified', verifiedBy: 'not-an-identity' }),
    ).rejects.toThrow('verifiedBy');
    const result = await service.transitionStatus(ORG_A, 'knowledge:own-1', {
      to: 'verified',
      verifiedBy: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    });
    expect(result.to).toBe('verified');
    expect(rows[0]?.status).toBe('verified');
    // verified→superseded 允许；superseded 为终态（任何再转移拒绝）
    const superseded = await service.transitionStatus(ORG_A, 'knowledge:own-1', { to: 'superseded' });
    expect(superseded.to).toBe('superseded');
    expect(rows[0]?.status).toBe('superseded');
    await expect(
      service.transitionStatus(ORG_A, 'knowledge:own-1', {
        to: 'verified',
        verifiedBy: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
      }),
    ).rejects.toThrow('非法状态转移');
  });

  it('转移：共享层条目对租户只读（平台维护）', async () => {
    const sharedRow = rowOf('knowledge:shared-1', 'global', SENTINEL);
    const { service } = createKnowledgeDb([sharedRow]);
    await expect(
      service.transitionStatus(SENTINEL, 'knowledge:shared-1', { to: 'superseded' }),
    ).rejects.toThrow('shared_entry_readonly');
  });
});
