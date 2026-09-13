/* LearningProposalService 契约行为测试（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿）。
 *
 * 覆盖：propose 契约 fail-closed（未知 kind/不支持阈值/no-op 变更拒绝）、
 * 影子评估证据由服务端库内遥测窗口重建（R2-SBZ-004：客户端 facts 不作证据、
 * evaluationRef 强制绑定、provenance 字段级来源标注）、proposalId 幂等回读不重复发事件、
 * 状态机强制（无影子证据/非法转移拒绝）、人审 approve（approvedBy 必填 +
 * approvedAt + 事件）、reject/rollback 理由强制、getActiveThresholds 激活面
 * （同参数最新 approved 生效、rolled_back 不再激活）、LearningProposalCreated/
 * Resolved 双事件。DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由
 * standalone_045 verify + CI 承担）。
 */
/// <reference types="jest" />
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LearningProposalService } from '../learning-proposal.service';
import { ewohLearningProposal, ewohEvent, ewohTelemetry, ewohLearningEvaluation } from '@server/database/schema';
import { validateDecision } from '@shared/decision';
import { DEFAULT_WORKLOAD_THRESHOLD, REASONING_ENGINE_VERSION } from '@shared/reasoning-trace';

const ORG_A = 'org-a';

function asProposal(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

const PROPOSER = 'person:proposer-1';
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
  sets: { proposalIds: Set<string>; orgIds: Set<string>; statuses: Set<string>; evalIds: Set<string> },
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
      // R2-SBZ-004：evaluationRef 绑定查询按 evalId 匹配学习评估台账行。
      if (value.startsWith('eval-')) sets.evalIds.add(value);
    } else {
      collectValues(value, sets, seen);
    }
  }
}

function matches(cond: unknown, row: Record<string, unknown>): boolean {
  const sets = { proposalIds: new Set<string>(), orgIds: new Set<string>(), statuses: new Set<string>(), evalIds: new Set<string>() };
  collectValues(cond, sets, new WeakSet());
  if (sets.proposalIds.size > 0 && !sets.proposalIds.has(String(row.proposalId))) return false;
  if (sets.orgIds.size > 0 && !sets.orgIds.has(String(row.orgId))) return false;
  if (sets.statuses.size > 0 && !sets.statuses.has(String(row.status))) return false;
  if (sets.evalIds.size > 0 && !sets.evalIds.has(String(row.evalId))) return false;
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

// R2-SBZ-004：库内事实源行（ewoh_telemetry org 作用域遥测）。
function telemetryRow(orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000t1',
    deviceId: 'device:exo-1',
    entityId: 'person:p1',
    ts: new Date(),
    loadScore: 0.82,
    fatigueTrend: 0.8,
    orgId,
    ...overrides,
  };
}

// R2-SBZ-004：学习评估台账行（evaluationRef 绑定窗口来源）。
function evaluationRow(orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    orgId,
    evalId: 'eval-2026w33',
    evaluationType: 'periodic',
    periodStart: new Date(Date.now() - 3 * 60 * 60 * 1000),
    periodEnd: new Date(),
    engineVersion: 'v1',
    metricsJson: {},
    basisJson: {},
    resultJson: {},
    ...overrides,
  };
}

function createProposalDb(
  rows: Array<Record<string, unknown>> = [],
  opts: {
    telemetry?: Array<Record<string, unknown>>;
    evaluations?: Array<Record<string, unknown>>;
  } = {},
) {
  const state = {
    rows: [...rows],
    telemetry: [...(opts.telemetry ?? [])],
    evaluations: [...(opts.evaluations ?? [])],
  };
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
  // R2-SBZ-004：select 按表分桶（proposals / telemetry / learning_evaluation）。
  const bucketFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === ewohTelemetry) return state.telemetry;
    if (table === ewohLearningEvaluation) return state.evaluations;
    return state.rows;
  };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn((cond: unknown) => thenable(bucketFor(table).filter((r) => matches(cond, r)))),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohLearningProposal) state.rows.push(row);
        if (table === ewohEvent) events.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    // NEST-344：事务透传（终态转移与事件同事务）。
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
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
      service.propose({ kind: 'policy_weight', change: CHANGE }, ORG_A, PROPOSER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('R2-SBZ-004：propose 影子评估由服务端库内遥测窗口驱动（客户端 facts 不作证据）+ provenance 标注', async () => {
    // 库内高负荷遥测（loadScore 0.82 / fatigue 0.8）vs 客户端伪造低风险 facts。
    const { rows, events, service } = createProposalDb(
      [],
      { telemetry: [telemetryRow(ORG_A, { entityId: 'person:p1', loadScore: 0.82, fatigueTrend: 0.8 })] },
    );
    const forgedLowRiskFacts = [
      { subjectId: 'person:p1', kind: 'person', values: { workload: 0.1, fatigue: 0.1, ergonomicRisk: 0.1 } },
    ];
    const result = await service.propose(
      { kind: 'rule_threshold', change: CHANGE, facts: forgedLowRiskFacts },
      ORG_A,
      PROPOSER,
    );
    expect(result.created).toBe(true);
    expect(asProposal(result.proposal).status).toBe('shadow_evaluated');
    const shadowEval = asProposal(result.proposal).shadowEval as Record<string, unknown>;
    // 证据 = 服务端窗口（workload 0.82 ≥ 基线 0.8 且 fatigue 0.8 ≥ 0.7 → baseline 命中），
    // 客户端伪造的 0.1 低负荷事实不参与——洗白攻击失效。
    expect(shadowEval.factsCount).toBe(1);
    expect(shadowEval.baselineFires).toBe(1);
    expect(shadowEval.candidateFires).toBe(1);
    // 数据来源标注：字段级 provenance 显式落 recordJson 并透出。
    const provenance = asProposal(result.proposal).shadowFactsProvenance as Record<string, unknown>;
    expect(provenance.source).toBe('server:ewoh_telemetry');
    expect((provenance.fields as Record<string, string>).ergonomicRisk).toContain('unavailable');
    // 客户端 facts 仅作对账提示留痕（accepted=false）。
    const reconciliation = asProposal(result.proposal).clientFactsReconciliation as Record<string, unknown>;
    expect(reconciliation.accepted).toBe(false);
    expect(rows[0]?.status).toBe('shadow_evaluated');
    expect(events.map((e) => e.eventType)).toEqual(['LearningProposalCreated']);
  });

  it('R2-SBZ-004：propose 库内窗口为空 → proposed（即使客户端供给 facts 也不作证据）', async () => {
    const { rows, service } = createProposalDb();
    const result = await service.propose({ kind: 'rule_threshold', change: CHANGE, facts: FACTS }, ORG_A, PROPOSER);
    expect(asProposal(result.proposal).status).toBe('proposed');
    expect(rows[0]?.status).toBe('proposed');
  });

  it('R2-SBZ-004：propose evaluationRef 未命中台账 → 显式拒绝（不接受伪造时间窗）', async () => {
    const { service } = createProposalDb();
    await expect(
      service.propose(
        { kind: 'rule_threshold', change: CHANGE, evaluationRef: { evalId: 'eval-not-exist' } },
        ORG_A,
        PROPOSER,
      ),
    ).rejects.toThrow('evaluation_ref_not_found');
  });

  it('R2-SBZ-004：propose evaluationRef 命中 → 用台账 period 作窗口（org 作用域）', async () => {
    const { service } = createProposalDb(
      [],
      {
        telemetry: [telemetryRow(ORG_A)],
        evaluations: [evaluationRow(ORG_A, { evalId: 'eval-bound-1' })],
      },
    );
    const result = await service.propose(
      { kind: 'rule_threshold', change: CHANGE, evaluationRef: { evalId: 'eval-bound-1' } },
      ORG_A,
      PROPOSER,
    );
    expect(asProposal(result.proposal).status).toBe('shadow_evaluated');
    const provenance = asProposal(result.proposal).shadowFactsProvenance as Record<string, unknown>;
    expect((provenance.window as Record<string, unknown>).basis).toBe('evaluationRef:eval-bound-1');
  });

  it('R2-SBZ-004：影子评估租户作用域——他租户遥测不进窗口', async () => {
    const { service } = createProposalDb(
      [],
      { telemetry: [telemetryRow('org-b')] },
    );
    const result = await service.propose({ kind: 'rule_threshold', change: CHANGE }, ORG_A, PROPOSER);
    expect(asProposal(result.proposal).status).toBe('proposed');
  });

  it('proposalId 幂等：同 org+proposalId 回读且不重复发事件', async () => {
    const { events, service } = createProposalDb(
      [],
      { telemetry: [telemetryRow(ORG_A)] },
    );
    const first = await service.propose({ proposalId: 'lp:fixed-1', kind: 'rule_threshold', change: CHANGE }, ORG_A, PROPOSER);
    expect(first.created).toBe(true);
    const second = await service.propose({ proposalId: 'lp:fixed-1', kind: 'rule_threshold', change: CHANGE }, ORG_A, PROPOSER);
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

  it('shadow 端点：proposed→shadow_evaluated（服务端窗口补做）；库内窗口为空 fail-closed；非 proposed 拒绝', async () => {
    const { rows, service } = createProposalDb(
      [
        rowOf('lp:p1', ORG_A, { status: 'proposed', shadowEvalJson: null }),
        rowOf('lp:p2', ORG_A, { id: '00000000-0000-4000-8000-000000000003', status: 'proposed', shadowEvalJson: null }),
        rowOf('lp:a1', ORG_A, { id: '00000000-0000-4000-8000-000000000004', status: 'approved', approvedBy: 'person:x', approvedAt: new Date() }),
      ],
      {
        // R2-SBZ-004：shadow 的证据窗口来自库内遥测（客户端 facts 不作证据）。
        telemetry: [
          telemetryRow(ORG_A, { entityId: 'person:p1', loadScore: 0.82, fatigueTrend: 0.8 }),
          telemetryRow(ORG_A, { id: '00000000-0000-4000-8000-0000000000t2', entityId: 'person:p2', loadScore: 0.78, fatigueTrend: 0.75 }),
        ],
      },
    );
    const result = await service.shadow(ORG_A, 'lp:p1', FACTS);
    expect(asProposal(result).status).toBe('shadow_evaluated');
    expect((rows[0]?.shadowEvalJson as Record<string, unknown>).factsCount).toBe(2);
    // 客户端 facts 仅对账留痕。
    expect((asProposal(result).clientFactsReconciliation as Record<string, unknown>).accepted).toBe(false);
    // 库内无可重建窗口 → fail-closed（不接受客户端供给的证据）。
    const emptyWindowDb = createProposalDb(
      [rowOf('lp:p2', ORG_A, { status: 'proposed', shadowEvalJson: null })],
    );
    await expect(emptyWindowDb.service.shadow(ORG_A, 'lp:p2', FACTS)).rejects.toThrow('shadow_facts_window_empty');
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

  /* ------------------------------------------------------------------
   * B5 同族审批独立性（standalone_073）：提议人归属 + 生成人回避。
   * 与 plan.service SELF_APPROVAL_FORBIDDEN 同语义（同一治理口径）：
   * 比较用服务端权威口径，proposedBy 为 NULL 的存量行放行。
   * ------------------------------------------------------------------ */
  it('B5：propose 无提议人身份 → fail-closed 拒绝且不落库；带身份则列与响应双写 proposedBy', async () => {
    const { rows, service } = createProposalDb();
    await expect(
      service.propose({ kind: 'rule_threshold', change: CHANGE }, ORG_A),
    ).rejects.toThrow('propose 必须带非空 proposedBy');
    expect(rows).toHaveLength(0);

    const { rows: rowsWithProposer, service: serviceWithProposer } = createProposalDb();
    const result = await serviceWithProposer.propose(
      { kind: 'rule_threshold', change: CHANGE },
      ORG_A,
      PROPOSER,
    );
    expect(asProposal(result.proposal).proposedBy).toBe(PROPOSER);
    expect(rowsWithProposer[0]?.proposedBy).toBe(PROPOSER);
  });

  it('B5：提议人自批 → SELF_APPROVAL_FORBIDDEN 且不写入；他人可批；存量无归属行放行', async () => {
    // 自批：状态不变、无 Resolved 事件（拒绝发生在任何写入之前）。
    const self = createProposalDb([rowOf('lp:self', ORG_A, { proposedBy: 'person:approver-1' })]);
    await expect(self.service.approve(ORG_A, 'lp:self', 'person:approver-1'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(self.service.approve(ORG_A, 'lp:self', 'person:approver-1'))
      .rejects.toThrow('SELF_APPROVAL_FORBIDDEN');
    expect(self.rows[0]?.status).toBe('shadow_evaluated');
    expect(self.events).toHaveLength(0);

    // 跨人审批：正常进入 approved。
    const cross = createProposalDb([rowOf('lp:cross', ORG_A, { proposedBy: PROPOSER })]);
    const approved = await cross.service.approve(ORG_A, 'lp:cross', 'person:approver-2');
    expect(asProposal(approved).status).toBe('approved');
    expect(cross.rows[0]?.approvedBy).toBe('person:approver-2');

    // 存量行（standalone_073 之前的行无 proposedBy）：放行，避免历史提案被永久锁死。
    const legacy = createProposalDb([rowOf('lp:legacy', ORG_A)]);
    expect(asProposal(await legacy.service.approve(ORG_A, 'lp:legacy', PROPOSER)).status).toBe('approved');
  });

  /* ------------------------------------------------------------------
   * 阈值基线读面（决策原则 5）：来源 / 生效值 / 更新时间 / 影响面。
   * ------------------------------------------------------------------ */
  it('阈值基线：无覆盖 → 引擎内置常量（显式来源，provenance 为空，绝不冒充已激活策略）', async () => {
    const { service } = createProposalDb([
      rowOf('lp:pending', ORG_A, { status: 'proposed', shadowEvalJson: null, proposedBy: PROPOSER }),
    ]);
    const baseline = await service.getThresholdBaseline(ORG_A);
    expect(baseline.engineVersion).toBe(REASONING_ENGINE_VERSION);
    expect(new Date(baseline.readAt).toISOString()).toBe(baseline.readAt);
    expect(baseline.entries).toHaveLength(1);
    const [entry] = baseline.entries;
    expect(entry.ruleId).toBe('rule:worker-overload');
    expect(entry.parameter).toBe('workloadThreshold');
    expect(entry.effective).toBe(DEFAULT_WORKLOAD_THRESHOLD);
    expect(entry.engineDefault).toBe(DEFAULT_WORKLOAD_THRESHOLD);
    expect(entry.source).toBe('engine_default');
    expect(entry.provenance).toBeNull();
    expect(entry.counts).toEqual({ pending: 1, approved: 0, rejected: 0, rolledBack: 0 });
  });

  it('阈值基线：approved 覆盖 → 生效值为候选值 + 提案/审批/影子证据来源；在途与历史计数分离', async () => {
    const { service } = createProposalDb([
      rowOf('lp:a1', ORG_A, {
        status: 'approved',
        candidateValue: 0.75,
        proposedBy: PROPOSER,
        approvedBy: 'person:approver-2',
        approvedAt: new Date('2026-08-16T10:00:00Z'),
        recordJson: {
          proposalId: 'lp:a1',
          kind: 'rule_threshold',
          status: 'approved',
          change: { ...CHANGE },
          auditTrail: true,
          shadowFactsProvenance: {
            source: 'server:ewoh_telemetry',
            window: { from: '2026-08-09T00:00:00Z', to: '2026-08-16T00:00:00Z' },
            factsCount: 3,
            fields: { workload: 'ewoh_telemetry.load_score' },
          },
        },
      }),
      rowOf('lp:rej', ORG_A, { status: 'rejected', candidateValue: 0.6, rejectedBy: 'person:x', rejectedReason: '证据不足' }),
      rowOf('lp:rb', ORG_A, {
        status: 'rolled_back', candidateValue: 0.7,
        rolledBackBy: 'person:x', rolledBackReason: '误伤过频', approvedBy: 'person:x', approvedAt: new Date(),
      }),
      rowOf('lp:pending', ORG_A, { status: 'shadow_evaluated' }),
      rowOf('lp:other-org', 'org-b', { status: 'approved', candidateValue: 0.5, approvedAt: new Date() }),
    ]);
    const baseline = await service.getThresholdBaseline(ORG_A);
    const [entry] = baseline.entries;
    expect(entry.effective).toBe(0.75);
    expect(entry.source).toBe('approved_proposal');
    expect(entry.provenance).toMatchObject({
      proposalId: 'lp:a1',
      baselineValue: 0.8,
      candidateValue: 0.75,
      proposedBy: PROPOSER,
      approvedBy: 'person:approver-2',
      approvedAt: '2026-08-16T10:00:00.000Z',
    });
    expect(entry.provenance?.shadowFactsProvenance?.source).toBe('server:ewoh_telemetry');
    expect(entry.counts).toEqual({ pending: 1, approved: 1, rejected: 1, rolledBack: 1 });
  });

  it('阈值基线：租户作用域——他租户 approved 提案不影响本租户基线；缺 orgId fail-closed', async () => {
    const { service } = createProposalDb([
      rowOf('lp:other-org', 'org-b', { status: 'approved', candidateValue: 0.5, approvedAt: new Date() }),
    ]);
    const baseline = await service.getThresholdBaseline(ORG_A);
    expect(baseline.entries[0].source).toBe('engine_default');
    expect(baseline.entries[0].effective).toBe(DEFAULT_WORKLOAD_THRESHOLD);
    await expect(service.getThresholdBaseline('')).rejects.toThrow('orgId 缺失');
  });
});

