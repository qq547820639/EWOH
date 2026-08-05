import {
  hasPendingWork,
  updateSafety,
  contractStatus,
  API_CONTRACT_VERSION,
} from './swRegistration';

describe('swRegistration update safety (drafts / pending work)', () => {
  it('hasPendingWork is true when drafts or pending actions exist', () => {
    expect(hasPendingWork({ drafts: 0, pendingActions: 0 })).toBe(false);
    expect(hasPendingWork({ drafts: 1, pendingActions: 0 })).toBe(true);
    expect(hasPendingWork({ drafts: 0, pendingActions: 2 })).toBe(true);
  });

  it('updateSafety blocks a forced reload when drafts are unsaved', () => {
    const result = updateSafety({ drafts: 3, pendingActions: 0 });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('3');
  });

  it('updateSafety blocks when pending actions are unsynced', () => {
    const result = updateSafety({ drafts: 0, pendingActions: 2 });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('2');
  });

  it('updateSafety blocks when both drafts and pending actions exist', () => {
    const result = updateSafety({ drafts: 1, pendingActions: 1 });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('1 份未保存草稿');
    expect(result.reason).toContain('1 项未同步操作');
  });

  it('updateSafety allows an immediate update with no pending work', () => {
    expect(updateSafety({ drafts: 0, pendingActions: 0 })).toEqual({
      safe: true,
      reason: '',
    });
  });
});

describe('swRegistration contract status (fail-closed)', () => {
  it('accepts a compatible server contract', () => {
    expect(contractStatus('1.0.0')).toEqual({ ok: true });
  });

  it('fails closed on a major-version mismatch', () => {
    const result = contractStatus('2.0.0');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.server).toBe('2.0.0');
    }
  });

  it('fails closed when the server contract is absent', () => {
    const result = contractStatus(null);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.server).toBe('(未知)');
    }
  });

  it('exposes the shared client contract version', () => {
    expect(API_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});