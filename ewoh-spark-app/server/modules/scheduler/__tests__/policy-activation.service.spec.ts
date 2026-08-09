import { PolicyActivationService } from '../policy-activation.service';
import type { PolicyGateEvaluation, PolicyReplayRecord } from '@shared/api.interface';

describe('PolicyActivationService（P4-GATE：Human-gated Activation）', () => {
  const makeDb = () => {
    const policyRows: Array<Record<string, unknown>> = [];
    const activationRows: Array<Record<string, unknown>> = [];
    return {
      policyRows,
      activationRows,
      db: {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(policyRows.slice(0, 1))) })),
          })),
        })),
        update: jest.fn(() => ({
          set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve(undefined)) })),
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
        })),
      })),
    }));
    dbAny.insert.mockImplementation(() => ({
      values: jest.fn(() => Promise.resolve(undefined)),
    }));
    const svc = new PolicyActivationService(db, replayService, kpiService, metrics, outbox);
    const gatePassed: PolicyGateEvaluation = {
      passed: true,
      checks: [],
      replayId: null,
      shadowEvaluation: { shadowRuns: 0, shadowConflicts: 0, safetyViolations: 0, blockedRouteAssignments: 0, fallbackRate: null, conflictRate: null },
    };
    const record = await svc.activate(2, { operator: 'admin', reason: 'kpi ok', gateResult: gatePassed });
    expect(record.status).toBe('ACTIVATED');
    expect(record.beforeVersion).toBe(1);
    expect(record.rollbackTarget).toBe(1);
    expect(record.operator).toBe('admin');
  });
});
