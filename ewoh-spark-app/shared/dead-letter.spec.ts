/* DeadLetter 契约测试（ADR-024 / NO-11a，§20 Reliability 失败终态）。
 *
 * 覆盖：reason/status 封闭注册表（未知拒绝）、envelope 快照必填、attempts ≥ 1、
 * discard 理由强制、合法 pending/requeued/discarded 通过。
 */
/// <reference types="jest" />
import { validateDeadLetter } from './dead-letter';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    letterId: 'dl:abc123:EVT-1',
    sourceId: 'cloud:ingest',
    reason: 'unknown_event_type',
    attempts: 1,
    status: 'pending',
    envelope: { eventId: 'EVT-1', eventType: 'TeleportEvent' },
    correlationId: null,
    auditTrail: true,
    ...overrides,
  };
}

describe('validateDeadLetter（ADR-024 契约）', () => {
  it('合法 pending 通过', () => {
    expect(validateDeadLetter(record())).toEqual([]);
  });

  it('合法 requeued（attempts 递增）通过', () => {
    expect(validateDeadLetter(record({ status: 'requeued', attempts: 2 }))).toEqual([]);
  });

  it('合法 discarded（带理由）通过', () => {
    expect(
      validateDeadLetter(record({ status: 'discarded', discardedReason: '固件错误人工确认丢弃' })),
    ).toEqual([]);
  });

  it('未知 reason → unknown_reason', () => {
    expect(validateDeadLetter(record({ reason: 'teleport_failure' }))[0]).toBe('unknown_reason');
  });

  it('attempts=0 → bad_attempts（禁止自动无限重试的机器面）', () => {
    expect(validateDeadLetter(record({ attempts: 0 }))[0]).toBe('bad_attempts');
  });

  it('discarded 无理由 → discard_reason_required（§33 不静默）', () => {
    expect(validateDeadLetter(record({ status: 'discarded' }))[0]).toBe('discard_reason_required');
  });

  it('envelope 缺失 → missing_field:envelope（§3 失败证据必填）', () => {
    const r = record();
    delete (r as Record<string, unknown>).envelope;
    expect(validateDeadLetter(r)[0]).toBe('missing_field:envelope');
  });

  it('auditTrail=false → audit_required', () => {
    expect(validateDeadLetter(record({ auditTrail: false }))[0]).toBe('audit_required');
  });
});
