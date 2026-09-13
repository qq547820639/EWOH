/* NO-41a：佩戴事实双源交叉校验（会话声明 × 设备遥测）的判定口径。
 *
 * 钉死六种判定与"证据不足绝不升级为结论"的红线：
 *   consistent / wearer_mismatch / activity_only / inactive_suspect / stale_telemetry / no_telemetry
 */
/// <reference types="jest" />
import {
  EXO_TELEMETRY_ACTIVITY_THRESHOLD,
  EXO_TELEMETRY_FRESH_MS,
  classifyExoTelemetryConsistency,
  type ExoTelemetryEvidence,
} from '../exo-session-telemetry';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const WEARER = 'person:63000000-0000-4000-8000-000000000001';

const session = { sessionId: 'exo-session:t1', personId: WEARER, exoId: 'device:EXO-1' };

function evidence(overrides: Partial<ExoTelemetryEvidence> = {}): ExoTelemetryEvidence {
  return {
    ts: iso(NOW - 30_000),
    workerId: '63000000-0000-4000-8000-000000000001',
    loadScore: 0.4,
    assistLevel: null,
    angularVelocityDps: 3,
    sourceType: 'real',
    dataQuality: 'good',
    ...overrides,
  };
}

describe('classifyExoTelemetryConsistency', () => {
  it('遥测佩戴人与会话一致 → consistent（同一个人，两源互相印证）', () => {
    const result = classifyExoTelemetryConsistency({ session, evidence: evidence() }, { nowMs: NOW });
    expect(result.verdict).toBe('consistent');
    expect(result.needsHumanCheck).toBe(false);
    expect(result.evidenceAgeMs).toBe(30_000);
    expect(result.reason).toContain('一致');
  });

  it('遥测佩戴人是另一个人 → wearer_mismatch（硬冲突，必须人核实）', () => {
    const result = classifyExoTelemetryConsistency(
      { session, evidence: evidence({ workerId: 'person:other-person' }) },
      { nowMs: NOW },
    );
    expect(result.verdict).toBe('wearer_mismatch');
    expect(result.needsHumanCheck).toBe(true);
    expect(result.reason).toContain('other-person');
    expect(result.reason).toContain('不替任何一方下结论');
  });

  it('没有任何遥测帧 → no_telemetry（无佐证，**不是**"没在戴"）', () => {
    const result = classifyExoTelemetryConsistency({ session, evidence: null }, { nowMs: NOW });
    expect(result.verdict).toBe('no_telemetry');
    expect(result.needsHumanCheck).toBe(false);
    expect(result.reason).toContain('不等于"没有佩戴"');
  });

  it('遥测帧已过期 → stale_telemetry（证据过期，不下结论）', () => {
    const result = classifyExoTelemetryConsistency(
      { session, evidence: evidence({ ts: iso(NOW - EXO_TELEMETRY_FRESH_MS - 60_000) }) },
      { nowMs: NOW },
    );
    expect(result.verdict).toBe('stale_telemetry');
    expect(result.needsHumanCheck).toBe(false);
    expect(result.reason).toContain('已过期');
  });

  it('帧无法解析时间 → stale_telemetry 且说明原值（不静默丢弃证据）', () => {
    const result = classifyExoTelemetryConsistency(
      { session, evidence: evidence({ ts: 'not-a-time' }) },
      { nowMs: NOW },
    );
    expect(result.verdict).toBe('stale_telemetry');
    expect(result.reason).toContain('not-a-time');
  });

  it('未上报佩戴人但指标有活动 → activity_only（只能证明"有人在用"）', () => {
    const result = classifyExoTelemetryConsistency(
      { session, evidence: evidence({ workerId: null, loadScore: 0.5, angularVelocityDps: 0, assistLevel: null }) },
      { nowMs: NOW },
    );
    expect(result.verdict).toBe('activity_only');
    expect(result.needsHumanCheck).toBe(false);
    expect(result.reason).toContain('无法确认是谁');
  });

  it('未上报佩戴人且指标全静 → inactive_suspect（用词必须是"疑似"，需核实）', () => {
    const result = classifyExoTelemetryConsistency(
      {
        session,
        evidence: evidence({
          workerId: null,
          loadScore: EXO_TELEMETRY_ACTIVITY_THRESHOLD,
          assistLevel: 0,
          angularVelocityDps: 0,
        }),
      },
      { nowMs: NOW },
    );
    expect(result.verdict).toBe('inactive_suspect');
    expect(result.needsHumanCheck).toBe(true);
    expect(result.reason).toContain('疑似');
  });

  it('阈值/新鲜窗口可配置；会话佩戴者缺失且遥测有佩戴人 → 也算不一致（无法证明是同一人）', () => {
    const strict = classifyExoTelemetryConsistency(
      { session, evidence: evidence({ workerId: null, loadScore: 0.06, angularVelocityDps: null }) },
      { nowMs: NOW, activityThreshold: 0.5 },
    );
    expect(strict.verdict).toBe('inactive_suspect');

    const noSessionPerson = classifyExoTelemetryConsistency(
      { session: { ...session, personId: null }, evidence: evidence() },
      { nowMs: NOW },
    );
    expect(noSessionPerson.verdict).toBe('wearer_mismatch');
    expect(noSessionPerson.reason).toContain('未记录');
  });
});
