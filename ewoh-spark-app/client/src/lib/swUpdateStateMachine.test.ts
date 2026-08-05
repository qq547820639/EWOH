import {
  createSwUpdateStateMachine,
  nextState,
  isValidTransition,
  SW_UPDATE_STATES,
  type SwUpdateStateMachine,
} from './swUpdateStateMachine';

describe('swUpdateStateMachine transitions', () => {
  it('walks the happy path checking -> available -> ... -> success', () => {
    const m = createSwUpdateStateMachine();
    expect(m.getState()).toBe('checking');
    expect(m.dispatch('DRAFTS_SAVED')).toBe('checking'); // invalid from here: no-op
    expect(m.dispatch('UPDATE_FOUND')).toBe('available');
    expect(m.dispatch('SAVING_START')).toBe('saving-drafts');
    // 草稿与离线队列已持久化后才进入 activating。
    expect(m.dispatch('DRAFTS_SAVED')).toBe('activating');
    expect(m.dispatch('ACTIVATING')).toBe('activating'); // no-op (not a transition)
    expect(m.dispatch('ACTIVATED')).toBe('reloading');
    expect(m.dispatch('RELOADED')).toBe('success');
    expect(m.isTerminal()).toBe(true);
  });

  it('treats no-update as a terminal success (nothing to do)', () => {
    const m = createSwUpdateStateMachine();
    expect(m.dispatch('NO_UPDATE')).toBe('success');
    expect(m.isTerminal()).toBe(true);
  });

  it('fails closed when draft/queue persistence fails before activating', () => {
    const m = createSwUpdateStateMachine();
    m.dispatch('UPDATE_FOUND');
    m.dispatch('SAVING_START');
    expect(m.dispatch({ type: 'SAVE_FAILED', reason: 'idb-error' })).toBe('failed');
    expect(m.isTerminal()).toBe(true);
    expect(m.reason).toBe('idb-error');
  });

  it('fails when a blocking error occurs mid-flow', () => {
    const m = createSwUpdateStateMachine();
    m.dispatch('UPDATE_FOUND');
    m.dispatch('SAVING_START');
    m.dispatch('DRAFTS_SAVED');
    expect(m.dispatch('ACTIVATING')).toBe('activating');
    expect(m.dispatch({ type: 'FAIL', reason: 'activate-timeout' })).toBe('failed');
    expect(m.reason).toBe('activate-timeout');
  });

  it('rolls back when the new worker fails to activate', () => {
    const m = createSwUpdateStateMachine();
    m.dispatch('UPDATE_FOUND');
    m.dispatch('SAVING_START');
    m.dispatch('DRAFTS_SAVED');
    expect(m.dispatch('ACTIVATION_FAILED')).toBe('rollback');
    expect(m.isTerminal()).toBe(true);
  });

  it('rolls back when the reload onto the new shell fails', () => {
    const m = createSwUpdateStateMachine();
    m.dispatch('UPDATE_FOUND');
    m.dispatch('SAVING_START');
    m.dispatch('DRAFTS_SAVED');
    m.dispatch('ACTIVATED');
    expect(m.dispatch('RELOAD_FAILED')).toBe('rollback');
    expect(m.isTerminal()).toBe(true);
  });

  it('enters rollback on a service-worker rollback notification from any active state', () => {
    for (const m of [
      createSwUpdateStateMachine(),
      (() => {
        const mm = createSwUpdateStateMachine();
        mm.dispatch('UPDATE_FOUND');
        return mm;
      })(),
      (() => {
        const mm = createSwUpdateStateMachine();
        mm.dispatch('UPDATE_FOUND');
        mm.dispatch('SAVING_START');
        mm.dispatch('DRAFTS_SAVED');
        return mm;
      })(),
    ]) {
      expect(m.dispatch('ROLLBACK')).toBe('rollback');
      expect(m.isTerminal()).toBe(true);
    }
  });

  it('ignores invalid transitions and respects terminal states', () => {
    const m = createSwUpdateStateMachine();
    // Invalid event from checking has no effect.
    expect(m.dispatch('DRAFTS_SAVED')).toBe('checking');
    expect(m.dispatch('UPDATE_FOUND')).toBe('available');
    m.dispatch('SAVING_START');
    m.dispatch('DRAFTS_SAVED');
    m.dispatch('ACTIVATED');
    m.dispatch('RELOADED'); // -> success (terminal)
    expect(m.isTerminal()).toBe(true);
    // Terminal states reject further changes.
    expect(m.dispatch('ACTIVATED')).toBe('success');
    expect(m.dispatch('FAIL')).toBe('success');
  });

  it('nextState / isValidTransition reflect the transition table', () => {
    expect(isValidTransition('saving-drafts', 'DRAFTS_SAVED')).toBe(true);
    expect(nextState('saving-drafts', 'DRAFTS_SAVED')).toBe('activating');
    expect(isValidTransition('saving-drafts', 'RELOADED')).toBe(false);
    expect(nextState('saving-drafts', 'RELOADED')).toBeNull();
    expect(isValidTransition('success', 'FAIL')).toBe(false);
  });

  it('exposes all documented states', () => {
    expect(SW_UPDATE_STATES).toEqual([
      'checking',
      'available',
      'saving-drafts',
      'activating',
      'reloading',
      'success',
      'rollback',
      'failed',
    ]);
  });
});

describe('swUpdateStateMachine multi-version upgrade (acceptance C6-8)', () => {
  it('tracks a cross two-or-more-version promotion through the machine', () => {
    // A release that jumps the client from v0 to v2 (skipping v1 as a running
    // version): the flow still goes checking -> available -> saving-drafts ->
    // activating; the cache-level pruning (v0 removed, v1 kept as rollback,
    // v2 current) is exercised in swCache.test.ts via pruneCacheNames.
    const m: SwUpdateStateMachine = createSwUpdateStateMachine();
    m.dispatch('UPDATE_FOUND');
    m.dispatch('SAVING_START');
    m.dispatch('DRAFTS_SAVED');
    m.dispatch('ACTIVATED');
    m.dispatch('RELOADED');
    expect(m.getState()).toBe('success');
  });
});