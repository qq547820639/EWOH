/* LearningProposalService.propose 并发幂等回归（ADR-026）。
 *
 * 缺陷：propose 的幂等 = select 命中即回读，但 select→insert 之间存在 TOCTOU：
 * 两个并发同 proposalId 提交都未命中 → 后写者撞 (org_id, proposal_id) 唯一键，
 * 23505 裸抛 500（同族路径 outcome-annotation NEST-332 / knowledge / simulation
 * 均已收口为"冲突回读既有行"）。修复后并发落败方同样返回 created=false。
 */
/// <reference types="jest" />
import { LearningProposalService } from '../learning-proposal.service';
import { ewohEvent, ewohLearningProposal, ewohTelemetry } from '@server/database/schema';

const ORG_A = 'org-a';
const PROPOSER = 'person:proposer-1';
const CHANGE = {
  ruleId: 'rule:worker-overload',
  parameter: 'workloadThreshold',
  baselineValue: 0.8,
  candidateValue: 0.75,
};
const PROPOSAL_ID = 'lp:fixed-1';

/** fake：模拟并发时序——首个幂等 select 尚不可见（并发未提交），
 * insert 撞唯一键（23505），catch 内的回读 select 可见既有行。 */
function createRaceDb() {
  const existing = {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: ORG_A,
    proposalId: PROPOSAL_ID,
    kind: 'rule_threshold',
    status: 'shadow_evaluated',
    ruleId: CHANGE.ruleId,
    parameter: CHANGE.parameter,
    baselineValue: CHANGE.baselineValue,
    candidateValue: CHANGE.candidateValue,
    shadowEvalJson: { baselineThreshold: 0.8, candidateThreshold: 0.75, factsCount: 1, baselineFires: 1, candidateFires: 1, addedSubjects: [], removedSubjects: [], riskLevel: 'low' },
    proposedBy: 'person:other',
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedReason: null,
    rolledBackBy: null,
    rolledBackReason: null,
    evaluationRefJson: null,
    recordJson: { proposalId: PROPOSAL_ID, kind: 'rule_threshold', status: 'shadow_evaluated', change: { ...CHANGE }, auditTrail: true },
    createdAt: new Date(),
  };
  let proposalSelects = 0;
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === ewohLearningProposal) {
            proposalSelects += 1;
            // 第 1 次（幂等预检）：并发对手未提交 → 空；第 2 次（23505 回读）→ 可见。
            const hit = proposalSelects >= 2 ? [existing] : [];
            return { limit: jest.fn(async () => hit), orderBy: jest.fn(() => ({ limit: jest.fn(async () => hit) })) };
          }
          // 影子事实窗口（telemetry）：空 → 本提案状态 proposed（与断言无关）。
          return { limit: jest.fn(async () => []), orderBy: jest.fn(() => ({ limit: jest.fn(async () => []) })) };
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn(() => {
        if (table === ewohLearningProposal) {
          const err = Object.assign(new Error('unique constraint'), { code: '23505' });
          throw err;
        }
        return { returning: jest.fn(async () => []) };
      }),
    })),
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({ returning: jest.fn(async () => []) })),
      })),
    })),
  };
  const service = new LearningProposalService(db as never);
  return { service };
}

describe('LearningProposalService.propose 并发幂等（23505 → 回读，不 500）', () => {
  it('并发同 proposalId 落败方返回 created=false（唯一键冲突被收口）', async () => {
    const { service } = createRaceDb();
    const result = await service.propose(
      { proposalId: PROPOSAL_ID, kind: 'rule_threshold', change: CHANGE },
      ORG_A,
      PROPOSER,
    );
    expect(result.created).toBe(false);
    expect((result.proposal as Record<string, unknown>).proposalId).toBe(PROPOSAL_ID);
  });
});
