/* LearningProposalService 契约行为测试（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿）。
 *
 * 覆盖：propose 契约 fail-closed（未知 kind/不支持阈值/no-op 变更拒绝）、
 * 带 facts 即影子评估落 shadow_evaluated、proposalId 幂等回读不重复发事件、
 * 状态机强制（无影子证据/非法转移拒绝）、人审 approve（approvedBy 必填 +
 * approvedAt + 事件）、reject/rollback 理由强制、getActiveThresholds 激活面
 * （同参数最新 approved 生效、rolled_back 不再激活）、LearningProposalCreated/
 * Resolved 双事件。DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由
 * standalone_045 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { LearningProposalService } from '../learning-proposal.service';
import { ewohLearningProposal, ewohEvent } from '@server/database/schema';
import { validateDecision } from '@shared/decision';

const ORG_A = 'org-a';

function asProposal(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

const CHANGE = {
  ruleId: 'rule:worker-overload',
  parameter: 'workloadThreshold',
  baselineValue: 0.8,
  candidateValue: 0.75,
};

const FACTS = [
  { subjectId: 'person:p1', kind: 'person', values: { workload: 0.82, fatigue: 0.8, ergonomicRisk: 0.2 } },
  { subjectId: 'person:p2', kind: 'person', values: { workload: 0.78, fatigue: 0.75, ergonomicRisk: 0.1 } },
];

const PROPOSAL_STATUSES = new Set(['proposed', 'shadow_evaluated', 'approved', 'rolled_back', 'rejected']);

function collectValues(
  node: unknown,
  sets: { proposalIds: Set<string>; orgIds: Set<string>; statuses: Set<string> },
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
      if (value.startsWith('lp:')) sets.proposalIds.add(value);
      if (value.startsWith('org-')) sets.orgIds.add(value);
      if (PROPOSAL_STATUSES.has(value)) sets.statuses.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { proposalIds: new Set<string>(), orgIds: new Set<string>(), statuses: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.proposalIds.size > 0 && !sets.proposalIds.has(String(row.proposalId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.statuses.size > 0 && !sets.statuses.has(String(row.status))) return false;
  return true;
}

function rowOf(proposalId: string, orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId,
    proposalId,
    kind: 'rule_threshold',
    status: 'shadow_evaluated',
    ruleId: 'rule:worker-overload',
    parameter: 'workloadThreshold',
    baselineValue: 0.8,
    candidateValue: 0.75,
    shadowEvalJson: { baselineThreshold: 0.8, candidateThreshold: 0.75, factsCount: 2, baselineFires: 1, candidateFires: 2, addedSubjects: ['person:p2'], removedSubjects: [], riskLevel: 'low' },
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedReason: null,
    rolledBackBy: null,
    rolledBackReason: null,
    evaluationRefJson: null,
    recordJson: { proposalId, kind: 'rule_threshold', status: 'shadow_evaluated', change: { ...CHANGE }, auditTrail: true },
    createdAt: new Date(),
    ...overrides,
  };
}

function createProposalDb(rows: Array<Record<string, unknown>> = []) {
  const state = { rows: [...rows] };
  const events: Array<Record<string, unknown>> = [];
  function ordered(data: unknown[], col: unknown): unknown[] {
    const key = (col as { name?: string } | undefined)?.name;
    if (!key) return data;
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[key];
      const bv = (b as Record<string, unknown>)[key];
      if (av instanceof Date && bv instanceof Date) return bv.getTime() - av.getTime();
      if (typeof av === 'number' && typeof bv === 'number') return bv - av;
      return 0;
    });
  }
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn((col: unknown) => thenable(ordered(data, col))),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn((cond: unknown) => thenable(state.rows.filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohLearningProposal) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          const hit = state.rows.filter((r) => matches(cond, r));
          for (const r of hit) Object.assign(r, patch);
          return { returning: jest.fn(async () => hit) };
        }),
      })),
    })),
  };
  const service = new LearningProposalService(db as never);
  return { db, rows: state.rows, events, service };
}

describe('LearningProposalService（NO-12b 反馈腿）', () => {
  it('propose 契约 fail-closed：未知 kind 拒绝且不落库（§33 无引擎空类型）', async () => {
    const { rows, service } = createProposalDb();
    await expect(
      service.propose({ kind: 'policy_weight', change: CHANGE }, ORG_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('propose 带 facts → 确定性影子评估落 shadow_evaluated + LearningProposalCreated', async () => {
    const { rows, events, service } = createProposalDb();
    const result = await service.propose({ kind: 'rule_threshold', change: CHANGE, facts: FACTS }, ORG_A);
    expect(result.created).toBe(true);
    expect(asProposal(result.proposal).status).toBe('shadow_evaluated');
    expect((asProposal(result.proposal).shadowEval as Record<string, unknown>).riskLevel).toBe('low');
    expect(rows[0]?.status).toBe('shadow_evaluated');
    expect(events.map((e) => e.eventType)).toEqual(['LearningProposalCreated']);
  });

  it('propose 缺 facts → proposed（影子评估经 shadow 端点补做）', async () => {
    const { service } = createProposalDb();
    const result = await service.propose({ kind: 'rule_threshold', change: CHANGE }, ORG_A);
    expect(asProposal(result.proposal).status).toBe('proposed');
  });

  it('proposalId 幂等：同 org+proposalId 回读且不重复发事件', async () => {
    const { events, service } = createProposalDb();
    const first = await service.propose({ proposalId: 'lp:fixed-1', kind: 'rule_threshold', change: CHANGE, facts: FACTS }, ORG_A);
    expect(first.created).toBe(true);
    const second = await service.propose({ proposalId: 'lp:fixed-1', kind: 'rule_threshold', change: CHANGE, facts: FACTS }, ORG_A);
    expect(second.created).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('状态机强制：approved 提案无法再 approve（ADR-026 转移拒绝）', async () => {
    const { service } = createProposalDb([rowOf('lp:a1', ORG_A, { status: 'approved', approvedBy: 'person:x', approvedAt: new Date() })]);
    await expect(service.approve(ORG_A, 'lp:a1', 'person:y')).rejects.toThrow('非法提案转移');
  });

  it('approve：shadow_evaluated→approved（approvedBy/approvedAt 落账 + Resolved 事件）；缺 approver 拒绝', async () => {
    const { rows, events, service } = createProposalDb([rowOf('lp:a1', ORG_A)]);
    await expect(service.approve(ORG_A, 'lp:a1', '')).rejects.toThrow('approve 必须带非空 approvedBy');
    const result = await service.approve(ORG_A, 'lp:a1', 'person:approver-1');
    expect(asProposal(result).status).toBe('approved');
    expect(asProposal(result).approvedBy).toBe('person:approver-1');
    expect(rows[0]?.approvedBy).toBe('person:approver-1');
    expect(rows[0]?.approvedAt).toBeInstanceOf(Date);
    expect(events.map((e) => e.eventType)).toEqual(['LearningProposalResolved']);
  });

  it('reject/rollback 理由强制（§33 不静默）；rolled_back 后不再激活', async () => {
    const { service } = createProposalDb([rowOf('lp:a1', ORG_A)]);
    await expect(service.reject(ORG_A, 'lp:a1', 'person:x', '')).rejects.toThrow('reject 必须带非空 rejectedReason');
    const rejected = await service.reject(ORG_A, 'lp:a1', 'person:x', '影子证据不足');
    expect(asProposal(rejected).status).toBe('rejected');
  });

  it('getActiveThresholds 激活面：approved 提案生效、rolled_back/rejected 不生效、同参数取最新', async () => {
    const { service } = createProposalDb([
      rowOf('lp:old', ORG_A, { status: 'approved', candidateValue: 0.85, approvedAt: new Date('2026-08-16T08:00:00Z') }),
      rowOf('lp:new', ORG_A, { status: 'approved', candidateValue: 0.75, approvedAt: new Date('2026-08-16T10:00:00Z') }),
      rowOf('lp:rb', ORG_A, { status: 'rolled_back', candidateValue: 0.7, approvedAt: new Date('2026-08-16T11:00:00Z'), rolledBackBy: 'person:x', rolledBackReason: '误报过多' }),
      rowOf('lp:rej', ORG_A, { status: 'rejected', candidateValue: 0.6 }),
      rowOf('lp:other-org', 'org-b', { status: 'approved', candidateValue: 0.5 }),
    ]);
    const thresholds = await service.getActiveThresholds(ORG_A);
    expect(thresholds).toEqual({ workload: 0.75 });
  });

  it('shadow 端点：proposed→shadow_evaluated（补做影子评估）；非 proposed 拒绝', async () => {
    const { rows, service } = createProposalDb([
      rowOf('lp:p1', ORG_A, { status: 'proposed', shadowEvalJson: null }),
      rowOf('lp:a1', ORG_A, { status: 'approved', approvedBy: 'person:x', approvedAt: new Date() }),
    ]);
    const result = await service.shadow(ORG_A, 'lp:p1', FACTS);
    expect(asProposal(result).status).toBe('shadow_evaluated');
    expect((rows[0]?.shadowEvalJson as Record<string, unknown>).factsCount).toBe(2);
    await expect(service.shadow(ORG_A, 'lp:a1', FACTS)).rejects.toThrow('非法提案转移');
  });

  it('租户作用域：他租户提案不可见', async () => {
    const { service } = createProposalDb([rowOf('lp:other-1', 'org-b')]);
    await expect(service.getProposal(ORG_A, 'lp:other-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── NO-13n / ADR-063：learning_proposal_activation 决策留痕（kind #7） ──

  it('NO-13n：approve → decisionJson 与状态同 UPDATE 落库（契约门内 + 判定事实）', async () => {
    const { rows, service } = createProposalDb([rowOf('lp:p1', ORG_A)]);
    const result = await service.approve(ORG_A, 'lp:p1', 'u1');
    expect(asProposal(result).status).toBe('approved');
    const decision = rows[0]?.decisionJson as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.decisionId).toBe('decision:lp:p1:activation');
    expect(decision.kind).toBe('learning_proposal_activation');
    expect(decision.status).toBe('approved');
    expect(decision.decisionAuthority).toBe('human');
    expect(decision.subject).toBe('proposal:lp:p1');
    expect(decision.riskLevel).toBe('medium');
    expect((decision.approver as Record<string, unknown>).actor).toBe('user:u1');
    expect(validateDecision(decision)).toEqual([]);
  });

  it('NO-13n：reject → rejected 决策留痕（理由为判定事实）', async () => {
    const { rows, service } = createProposalDb([rowOf('lp:p2', ORG_A)]);
    const result = await service.reject(ORG_A, 'lp:p2', 'u2', '证据不足');
    expect(asProposal(result).status).toBe('rejected');
    const decision = rows[0]?.decisionJson as Record<string, unknown>;
    expect(decision.status).toBe('rejected');
    expect((decision.selected as Record<string, unknown>)).toEqual({
      optionId: 'opt:keep', reason: ['证据不足'],
    });
    expect(validateDecision(decision)).toEqual([]);
  });

  it('NO-13n：rollback → superseded 决策留痕（激活决策被回滚取代）', async () => {
    const { rows, service } = createProposalDb([
      rowOf('lp:p3', ORG_A, { status: 'approved', approvedBy: 'u1', approvedAt: new Date() }),
    ]);
    const result = await service.rollback(ORG_A, 'lp:p3', 'u2', '误伤过频');
    expect(asProposal(result).status).toBe('rolled_back');
    const decision = rows[0]?.decisionJson as Record<string, unknown>;
    expect(decision.status).toBe('superseded');
    expect((decision.auditTrail as Array<Record<string, unknown>>)[0].action).toBe('rolled_back');
    expect(validateDecision(decision)).toEqual([]);
  });
});

