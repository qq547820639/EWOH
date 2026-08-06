import {
  assertTransition,
  canTransition,
  isTerminal,
  TERMINAL_EXPORT_STATUSES,
} from '../../../server/modules/operations/workbench-export-state';

describe('workbench-export-state (导出任务状态机)', () => {
  it('allows the happy path queued → running → succeeded', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
  });

  it('allows cancellation paths through cancelling', () => {
    expect(canTransition('queued', 'cancelling')).toBe(true);
    expect(canTransition('running', 'cancelling')).toBe(true);
    expect(canTransition('cancelling', 'cancelled')).toBe(true);
    expect(canTransition('cancelling', 'failed')).toBe(true);
  });

  it('allows retry from failed/expired back to running', () => {
    expect(canTransition('failed', 'running')).toBe(true);
    expect(canTransition('expired', 'running')).toBe(true);
  });

  it('allows expiry from queued/running/failed', () => {
    expect(canTransition('queued', 'expired')).toBe(true);
    expect(canTransition('running', 'expired')).toBe(true);
    expect(canTransition('failed', 'expired')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    expect(canTransition('queued', 'cancelled')).toBe(true);
  });

  it('assertTransition throws on an illegal transition', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow(
      'Invalid workbench export transition',
    );
    expect(() => assertTransition('queued', 'running')).not.toThrow();
  });

  it('classifies terminal states correctly', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('cancelling')).toBe(false);
    expect(TERMINAL_EXPORT_STATUSES.size).toBe(4);
  });
});