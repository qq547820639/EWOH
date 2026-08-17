/* decision-history.service.spec.ts — Decision History 跨 kind 检索（NO-13p / ADR-065）。
 *
 * 只读聚合：四表（plan 数组 / agent_approval / learning_proposal /
 * scheduling_policy）→ 记录级租户过滤（统一面）→ validateDecision（§31
 * 单一校验器，非法显式 skippedInvalid）→ kind/status 过滤 fail-closed →
 * decidedAt 降序 + decisionId 字典序稳定 → 分页 cap。DB 以链式 fake 替换。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { DecisionHistoryService } from '../decision-history.service';
import {
  ewohSchedulePlan,
  ewohAgentApproval,
  ewohLearningProposal,
  ewohSchedulingPolicy,
} from '@server/database/schema';
import type { DecisionRecord } from '@shared/decision';

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const base: DecisionRecord = {
    decisionId: 'decision:d1',
    kind: 'task_assignment',
    status: 'proposed',
    decisionAuthority: 'optimization',
    subject: 'task:t1',
    tenantId: 'ORG-1',
    riskLevel: 'low',
    requiresApproval: true,
    decidedAt: '2026-08-16T10:00:00.000Z',
    selected: { optionId: 'opt:a', reason: ['r'] },
    auditTrail: [{ actor: 'solver:heuristic-v2', action: 'decided', at: '2026-08-16T10:00:00.000Z' }],
    ...overrides,
  };
  // 契约不变式：approved/rejected 必带 approver（测试助手自动补全判定事实）。
  if ((base.status === 'approved' || base.status === 'rejected') && !base.approver) {
    base.approver = { actor: 'user:u1', at: base.decidedAt };
  }
  return base;
}

function makeDb(seed: {
  plans?: Array<{ decisionRecordsJson: unknown }>;
  approvals?: Array<{ decisionJson: unknown }>;
  proposals?: Array<{ decisionJson: unknown }>;
  policies?: Array<{ decisionJson: unknown }>;
}) {
  const plans = seed.plans ?? [];
  const approvals = seed.approvals ?? [];
  const proposals = seed.proposals ?? [];
  const policies = seed.policies ?? [];
  const captured: Array<{ table: unknown; cond: unknown }> = [];

  const rowsOf = (table: unknown): Array<Record<string, unknown>> => {
    if (table === ewohSchedulePlan) return plans as Array<Record<string, unknown>>;
    if (table === ewohAgentApproval) return approvals as Array<Record<string, unknown>>;
    if (table === ewohLearningProposal) return proposals as Array<Record<string, unknown>>;
    if (table === ewohSchedulingPolicy) return policies as Array<Record<string, unknown>>;
    return [];
  };

  const db = {
    select: jest.fn((cols?: unknown) => ({
      from: jest.fn((table: unknown) => {
        const q: any = Promise.resolve(rowsOf(table));
        q.where = (cond: unknown) => {
          captured.push({ table, cond });
          return q;
        };
        // R2-SSV-23：listDecisions 增加 orderBy(createdAt desc)+limit 上界（fake 直通）。
        q.orderBy = () => q;
        q.limit = () => q;
        return q;
      }),
    })),
  };
  return { db, captured };
}

describe('DecisionHistoryService（NO-13p / ADR-065：跨 kind 检索）', () => {
  it('四表聚合 + 记录级租户过滤（跨源统一面 §15）+ 排序 decidedAt 降序稳定', async () => {
    const { db } = makeDb({
      plans: [
        { decisionRecordsJson: [decision({ decisionId: 'decision:p-1', decidedAt: '2026-08-16T12:00:00.000Z' })] },
        { decisionRecordsJson: [decision({ decisionId: 'decision:other-1', tenantId: 'ORG-2', decidedAt: '2026-08-16T13:00:00.000Z' })] },
      ],
      approvals: [
        { decisionJson: decision({ decisionId: 'decision:a-1', kind: 'agent_approval', status: 'approved', decidedAt: '2026-08-16T11:00:00.000Z' }) },
      ],
      proposals: [
        { decisionJson: decision({ decisionId: 'decision:l-1', kind: 'learning_proposal_activation', status: 'approved', decidedAt: '2026-08-16T09:00:00.000Z' }) },
      ],
      policies: [
        { decisionJson: decision({ decisionId: 'decision:pol-1', kind: 'policy_activation', status: 'executed', decidedAt: '2026-08-16T14:00:00.000Z' }) },
      ],
    });
    const svc = new DecisionHistoryService(db as never);
    const result = await svc.listDecisions('ORG-1');
    // 他租户记录被记录级过滤剔除。
    expect(result.items.map((r) => r.decisionId)).toEqual([
      'decision:pol-1', 'decision:p-1', 'decision:a-1', 'decision:l-1',
    ]);
    expect(result.total).toBe(4);
    // sources = 来源扫描量（含被租户过滤剔除的他租户记录——显式可审计）。
    expect(result.sources).toEqual({ plans: 2, agentApprovals: 1, learningProposals: 1, policies: 1 });
    expect(result.skippedInvalid).toBe(0);
  });

  it('kind + status 过滤（fail-closed 未知值 400）+ 分页 cap', async () => {
    const { db } = makeDb({
      plans: [
        {
          decisionRecordsJson: [
            decision({ decisionId: 'decision:p-1', kind: 'task_assignment', status: 'proposed' }),
            decision({ decisionId: 'decision:p-2', kind: 'plan_approval', status: 'approved', decidedAt: '2026-08-16T11:00:00.000Z' }),
          ],
        },
      ],
    });
    const svc = new DecisionHistoryService(db as never);
    const filtered = await svc.listDecisions('ORG-1', { kind: 'plan_approval', status: 'approved' });
    expect(filtered.items.map((r) => r.decisionId)).toEqual(['decision:p-2']);
    await expect(svc.listDecisions('ORG-1', { kind: 'bogus' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.listDecisions('ORG-1', { status: 'bogus' })).rejects.toBeInstanceOf(BadRequestException);
    // cap：limit 超 100 → 100。
    const many = Array.from({ length: 120 }, (_, i) =>
      decision({ decisionId: `decision:m${i}`, decidedAt: new Date(1_600_000_000_000 + i * 1000).toISOString() }),
    );
    const { db: db2 } = makeDb({ plans: [{ decisionRecordsJson: many }] });
    const svc2 = new DecisionHistoryService(db2 as never);
    const paged = await svc2.listDecisions('ORG-1', { limit: 1000 });
    expect(paged.items).toHaveLength(100);
    const offset = await svc2.listDecisions('ORG-1', { limit: 10, offset: 5 });
    expect(offset.items).toHaveLength(10);
    expect(offset.items[0].decisionId).toBe('decision:m114'); // 降序后 offset 5
  });

  it('非法记录显式 skippedInvalid 计数（§33 绝不静默丢弃）+ 缺租户 400', async () => {
    const { db } = makeDb({
      plans: [
        {
          decisionRecordsJson: [
            decision({ decisionId: 'decision:ok-1' }),
            { decisionId: 'not-a-decision', kind: 'bogus' }, // 非法
          ],
        },
      ],
    });
    const svc = new DecisionHistoryService(db as never);
    const result = await svc.listDecisions('ORG-1');
    expect(result.items).toHaveLength(1);
    expect(result.skippedInvalid).toBe(1);
    expect(result.sources.plans).toBe(2);
    await expect(svc.listDecisions('  ')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/** 深度搜索 SQL 树中是否引用了目标列实例（drizzle Column 对象不参与文本展开）。 */
function containsNode(node: unknown, target: unknown): boolean {
  if (node === target) return true;
  if (Array.isArray(node)) return node.some((n) => containsNode(n, target));
  if (node && typeof node === 'object' && 'queryChunks' in (node as object)) {
    return containsNode((node as { queryChunks: unknown }).queryChunks, target);
  }
  return false;
}

describe('DecisionHistoryService 方案来源 SQL org 条件（ADR-072）', () => {
  it('listDecisions 有 org → 方案来源查询含 plan.org_id SQL 条件（纵深第一层）', async () => {
    const { db, captured } = makeDb({
      plans: [
        { decisionRecordsJson: [decision()] },
      ],
    });
    const svc = new DecisionHistoryService(db as never);
    await svc.listDecisions('ORG-1');
    const planCond = captured.find((c) => c.table === ewohSchedulePlan);
    expect(planCond).toBeDefined();
    expect(containsNode(planCond?.cond, ewohSchedulePlan.orgId)).toBe(true);
    // 记录级 tenantId 过滤仍为第二层（ORG-2 记录被过滤）。
    const { db: db2, captured: captured2 } = makeDb({
      plans: [
        { decisionRecordsJson: [decision({ decisionId: 'decision:p-1' })] },
        { decisionRecordsJson: [decision({ decisionId: 'decision:other-1', tenantId: 'ORG-2' })] },
      ],
    });
    const svc2 = new DecisionHistoryService(db2 as never);
    const result = await svc2.listDecisions('ORG-1');
    expect(result.items.map((i) => i.decisionId)).toEqual(['decision:p-1']);
    expect(containsNode(captured2.find((c) => c.table === ewohSchedulePlan)?.cond, ewohSchedulePlan.orgId)).toBe(true);
  });
});
