import { PolicyActivationService } from '../policy-activation.service';
import type { PolicyGateEvaluation, PolicyReplayRecord } from '@shared/api.interface';

/** 默认候选策略 fixture（v2 / SHADOW）。 */
const DEFAULT_POLICY_ROWS: Array<Record<string, unknown>> = [
  { configVersion: 2, status: 'SHADOW', active: false },
];

/** 构造 Gate 评估结果（测试内直构，用于服务层组合语义）。 */
function gateEvaluation(overrides: Partial<PolicyGateEvaluation> = {}): PolicyGateEvaluation {
  return {
    passed: true,
    checks: [],
    replayId: null,
    insufficientEvidence: false,
    evidence: { evaluated: 0, skipped: 0, skippedChecks: [], candidatePolicyExists: true },
    shadowEvaluation: { shadowRuns: 0, shadowConflicts: 0, safetyViolations: 0, blockedRouteAssignments: 0, fallbackRate: null, conflictRate: null },
    ...overrides,
  };
}

describe('PolicyActivationService（P4-GATE：Human-gated Activation）', () => {
  /**
   * 默认种一行候选策略（v2 / SHADOW）。
   *
   * evaluateGate 现在会先校验候选策略存在——空库上"对不存在的策略算出一个
   * 通过结论"正是被修复的缺陷，所以默认 fixture 必须反映真实前提。
   * `policyRows` 可在用例内替换以模拟不存在/非 SHADOW 等场景。
   */
  const makeDb = (policyRows: Array<Record<string, unknown>> = DEFAULT_POLICY_ROWS) => {
    const activationRows: Array<Record<string, unknown>> = [];
    return {
      policyRows,
      activationRows,
      db: {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            // where() 同时支持 `.limit()`（候选查询）与 `.orderBy().limit()`
            // （当前 ACTIVE 查询）——activate 两条查询链都要能走通。
            where: jest.fn(() => ({
              limit: jest.fn(() => Promise.resolve(policyRows.slice(0, 1))),
              orderBy: jest.fn(() => ({
                limit: jest.fn(() => Promise.resolve(policyRows.slice(0, 1))),
              })),
            })),
          })),
        })),
        // R2-SSV-10：CAS UPDATE ... RETURNING（返回命中行）。
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({
              returning: jest.fn(async () => [{ id: 'row-1' }]),
            })),
          })),
        })),
        insert: jest.fn(() => ({
          values: jest.fn(() => Promise.resolve(undefined)),
        })),
        transaction: jest.fn(async (fn: () => Promise<void>) => fn()),
      } as never,
    };
  };

  const replayService = {
    getReplayRecord: jest.fn(),
  } as never;
  const kpiService = {
    aggregateForPolicyEvaluation: jest.fn().mockResolvedValue({
      onTimeRate: 0.9,
      latenessP95Ms: 60_000,
      fallbackRate: 0.1,
      conflictRate: 0.5,
      solverLatencyP95Ms: 800,
    }),
  } as never;
  const metrics = { recordPolicyEvent: jest.fn() } as never;
  const outbox = { enqueue: jest.fn().mockResolvedValue({}) } as never;

  it('evaluateGate：生产 KPI 全部达标 → passed=true', async () => {
    const { db } = makeDb();
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const gate = await svc.evaluateGate(2);
    expect(gate.passed).toBe(true);
    expect(gate.checks.every((c) => c.ok)).toBe(true);
  });

  it('evaluateGate：safety violations > 0 → passed=false（hard）', async () => {
    const replay: PolicyReplayRecord = {
      replayId: 'RPL-1',
      orgId: null,
      candidatePolicyVersion: 2,
      baselinePolicyVersion: 1,
      solverVersion: 'heuristic-v2',
      snapshotVersion: 'WS-1',
      seed: 1,
      status: 'COMPLETED',
      aggregateKpis: null,
      perRunResults: [
        { runId: 'r1', violations: [{ type: 'safety_blocked_person_assigned' }] },
      ],
      failures: [],
      startedAt: '2026-01-01',
      completedAt: '2026-01-01',
    };
    (replayService as unknown as { getReplayRecord: jest.Mock }).getReplayRecord.mockResolvedValue(replay);
    const { db } = makeDb();
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const gate = await svc.evaluateGate(2, 'RPL-1');
    expect(gate.passed).toBe(false);
    expect(gate.shadowEvaluation.safetyViolations).toBeGreaterThan(0);
    expect(gate.checks.find((c) => c.name === 'safety_violations_zero')?.ok).toBe(false);
  });

  it('activate：Gate 未通过 → 拒绝激活（POLICY_GATE_FAILED）', async () => {
    const { db } = makeDb();
    (db as never as { select: jest.Mock }).select.mockReturnValue({
      from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([{ configVersion: 2, status: 'SHADOW', active: false }])) })) })),
    });
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    // 强制 gate 失败：safety violations
    const replay: PolicyReplayRecord = {
      replayId: 'RPL-X', orgId: null, candidatePolicyVersion: 2, baselinePolicyVersion: 1,
      solverVersion: 'heuristic-v2', snapshotVersion: 'WS-1', seed: 1, status: 'COMPLETED',
      aggregateKpis: null,
      perRunResults: [{ runId: 'r1', violations: [{ type: 'safety_block' }] }],
      failures: [], startedAt: '2026-01-01', completedAt: '2026-01-01',
    };
    (replayService as unknown as { getReplayRecord: jest.Mock }).getReplayRecord.mockResolvedValue(replay);
    await expect(
      svc.activate(2, { operator: 'admin', replayId: 'RPL-X' }),
    ).rejects.toThrow(/POLICY_GATE_FAILED/);
  });

  it('activate：Gate 通过 + SHADOW 状态 → 激活成功并落审计（含 rollback target）', async () => {
    const { db } = makeDb();
    const dbAny = db as never as { select: jest.Mock; insert: jest.Mock };
    // candidate = SHADOW；active row = v1
    let call = 0;
    dbAny.select.mockImplementation(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() => {
            call += 1;
            if (call === 1) return Promise.resolve([{ configVersion: 2, status: 'SHADOW', active: false }]);
            return Promise.resolve([{ configVersion: 1, status: 'ACTIVE', active: true }]);
          }),
          orderBy: jest.fn(() => ({
            limit: jest.fn(() => {
              call += 1;
              if (call === 1) return Promise.resolve([{ configVersion: 2, status: 'SHADOW', active: false }]);
              return Promise.resolve([{ configVersion: 1, status: 'ACTIVE', active: true }]);
            }),
          })),
        })),
      })),
    }));
    dbAny.insert.mockImplementation(() => ({
      values: jest.fn(() => Promise.resolve(undefined)),
    }));
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const record = await svc.activate(2, { operator: 'admin', reason: 'kpi ok', gateResult: gateEvaluation() });
    expect(record.status).toBe('ACTIVATED');
    expect(record.beforeVersion).toBe(1);
    expect(record.rollbackTarget).toBe(1);
    expect(record.operator).toBe('admin');
  });

  it('activate：带 orgId 时全局策略（org_id IS NULL）也算当前 ACTIVE 并被归档（真实缺陷回归）', async () => {
    const { db } = makeDb();
    const dbAny = db as never as { select: jest.Mock; insert: jest.Mock; update: jest.Mock };
    // candidate = SHADOW；全局策略 org_id=NULL active=true（orgId 过滤必须包含 NULL）。
    let call = 0;
    // 记录 where 条件数量：首次=candidate 查询（1 个条件），二次=activeRow 查询（orgId 时含 isNull → 条件数 >= 2）。
    const whereConds: number[] = [];
    dbAny.select.mockImplementation(() => ({
      from: jest.fn(() => ({
        where: jest.fn((conds: unknown[]) => {
          whereConds.push(Array.isArray(conds) ? conds.length : 0);
          return {
            limit: jest.fn(() => {
              call += 1;
              if (call === 1) return Promise.resolve([{ configVersion: 2, status: 'SHADOW', active: false }]);
              // 全局策略（org_id NULL）命中 activeRow。
              return Promise.resolve([{ configVersion: 1, status: 'ACTIVE', active: true }]);
            }),
            orderBy: jest.fn(() => ({
              limit: jest.fn(() => {
                call += 1;
                if (call === 1) return Promise.resolve([{ configVersion: 2, status: 'SHADOW', active: false }]);
                // 全局策略（org_id NULL）命中 activeRow。
                return Promise.resolve([{ configVersion: 1, status: 'ACTIVE', active: true }]);
              }),
            })),
          };
        }),
      })),
    }));
    dbAny.insert.mockImplementation(() => ({
      values: jest.fn(() => Promise.resolve(undefined)),
    }));
    dbAny.update.mockImplementation(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn(async () => [{ id: 'row-1' }]),
        })),
      })),
    }));
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const record = await svc.activate(2, {
      operator: 'admin',
      gateResult: gateEvaluation(),
      orgId: 'ORG-1',
    });
    expect(record.beforeVersion).toBe(1); // 全局 ACTIVE 被识别为 before
    expect(record.rollbackTarget).toBe(1);
    // 防回归：orgId 激活必须执行到 activeRow 查询（第 2 次 select）——全局策略可被识别。
    expect(whereConds.length).toBeGreaterThanOrEqual(2);
  });

  // ==========================================================================
  // 2026-09-10 治理回归：Gate 不得对不存在的策略或缺失证据伪造"通过"结论
  // ==========================================================================

  it('evaluateGate：候选策略不存在 → 404，不再用空 KPI 算出 passed=true', async () => {
    const { db } = makeDb([]); // 空库：无任何策略行
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    await expect(svc.evaluateGate(99)).rejects.toThrow(/policy v99 not found/);
  });

  it('evaluateGate：缺数据的检查标记 skipped 并给出 insufficientEvidence，不再等同"通过"', async () => {
    const { db } = makeDb();
    const emptyKpi = {
      onTimeRate: null,
      latenessP95Ms: null,
      fallbackRate: null,
      conflictRate: null,
      solverLatencyP95Ms: null,
    };
    const emptyKpiService = {
      aggregateForPolicyEvaluation: jest.fn().mockResolvedValue(emptyKpi),
    } as never;
    const svc = new PolicyActivationService(db, replayService, emptyKpiService, metrics, outbox);
    const gate = await svc.evaluateGate(2);
    // passed 语义保持"无检查失败"，但必须同时暴露"没有证据"。
    expect(gate.passed).toBe(true);
    expect(gate.insufficientEvidence).toBe(true);
    expect(gate.evidence.evaluated).toBe(0);
    expect(gate.evidence.skipped).toBe(gate.checks.length);
    expect(gate.checks.every((c) => c.skipped)).toBe(true);
    // 无 replay → 安全检查同样属于"未评估"。
    expect(gate.evidence.skippedChecks).toContain('safety_violations_zero');
  });

  it('evaluateGate：有完整 KPI 证据时 insufficientEvidence=false（真实通过）', async () => {
    const { db } = makeDb();
    (replayService as unknown as { getReplayRecord: jest.Mock }).getReplayRecord.mockResolvedValue({
      replayId: 'RPL-OK', orgId: null, candidatePolicyVersion: 2, baselinePolicyVersion: 1,
      solverVersion: 'heuristic-v2', snapshotVersion: 'WS-1', seed: 1, status: 'COMPLETED',
      aggregateKpis: null, perRunResults: [{ runId: 'r1', violations: [] }],
      failures: [], startedAt: '2026-01-01', completedAt: '2026-01-01',
    } satisfies PolicyReplayRecord);
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const withReplay = await svc.evaluateGate(2, 'RPL-OK');
    // KPI 齐全 + replay 存在 → 每条检查都有证据，才是真正的"已验证通过"。
    expect(withReplay.insufficientEvidence).toBe(false);
    expect(withReplay.evidence.skipped).toBe(0);
    expect(withReplay.evidence.evaluated).toBe(withReplay.checks.length);
    expect(withReplay.passed).toBe(true);
  });

  it('activate：Gate 仅因缺证据通过 → 未显式确认时拒绝激活（INSUFFICIENT_EVIDENCE）', async () => {
    const { db } = makeDb();
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const unverified = gateEvaluation({
      insufficientEvidence: true,
      evidence: { evaluated: 0, skipped: 2, skippedChecks: ['on_time_rate', 'safety_violations_zero'], candidatePolicyExists: true },
    });
    await expect(
      svc.activate(2, { operator: 'admin', reason: 'activate anyway', gateResult: unverified }),
    ).rejects.toThrow(/POLICY_GATE_INSUFFICIENT_EVIDENCE/);
  });

  it('activate：显式 acknowledgeInsufficientEvidence 后允许激活，并把确认写入审计 JSON', async () => {
    const { db } = makeDb();
    const inserted: Array<Record<string, unknown>> = [];
    (db as never as { insert: jest.Mock }).insert.mockImplementation(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve(undefined);
      }),
    }));
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const unverified = gateEvaluation({
      insufficientEvidence: true,
      evidence: { evaluated: 0, skipped: 1, skippedChecks: ['on_time_rate'], candidatePolicyExists: true },
    });
    const record = await svc.activate(2, {
      operator: 'admin',
      reason: 'bootstrap activation',
      gateResult: unverified,
      acknowledgeInsufficientEvidence: true,
    });
    expect(record.status).toBe('ACTIVATED');
    const gateJson = inserted[0]?.gateResultJson as Record<string, unknown>;
    expect(gateJson.acknowledgedInsufficientEvidence).toBe(true);
  });
});
