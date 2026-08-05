/**
 * Pure, unit-testable state machine for the PWA service-worker update flow.
 *
 * The page-side update experience is driven through explicit states so the
 * transitions (drafts saved -> activating -> reload -> success | rollback |
 * failed) are deterministic rather than implicit in the registration wiring.
 * This module contains only pure logic — no browser APIs — so it can be tested
 * in isolation. The live `registerServiceWorker` wiring in `swRegistration.ts`
 * drives this machine with real events.
 *
 * States:
 *  - checking:       probing for a new version.
 *  - available:      a new version is installed & waiting (user may defer or apply).
 *  - saving-drafts:  persisting drafts + offline queue before activating.
 *  - activating:     the waiting worker is being activated (SKIP_WAITING).
 *  - reloading:      the worker activated; the page reloads onto the new shell.
 *  - success:        terminal — update applied cleanly (or none needed).
 *  - rollback:       terminal — new shell could not start; the page fell back to
 *                    the last-good shell (kept by the SW's activate cleanup).
 *  - failed:         terminal — a blocking error occurred before completion.
 */

export type SwUpdateState =
  | 'checking'
  | 'available'
  | 'saving-drafts'
  | 'activating'
  | 'reloading'
  | 'success'
  | 'rollback'
  | 'failed';

/**
 * Discriminated event type. `UPDATE_FOUND`/`NO_UPDATE`/`CHECK_FAIL` come from
 * the registration handshake; `SAVING_*`/`ACTIVAT*`/`RELOAD*` come from the
 * safe-update driver; `FAIL` is a generic escape hatch into the terminal state.
 */
export type SwUpdateEventType =
  | 'UPDATE_FOUND'
  | 'NO_UPDATE'
  | 'CHECK_FAIL'
  | 'SAVING_START'
  | 'DRAFTS_SAVED'
  | 'SAVE_FAILED'
  | 'ACTIVATING'
  | 'ACTIVATED'
  | 'ACTIVATION_FAILED'
  | 'RELOAD'
  | 'RELOADED'
  | 'RELOAD_FAILED'
  /** The service worker reported it fell back to the last-good shell. */
  | 'ROLLBACK'
  | 'FAIL';

export interface SwUpdateEvent {
  type: SwUpdateEventType;
  /** Optional reason for terminal failure, surfaced in metrics / UI. */
  reason?: string;
}

/** All machine states, ordered for diagnostics. */
export const SW_UPDATE_STATES: readonly SwUpdateState[] = [
  'checking',
  'available',
  'saving-drafts',
  'activating',
  'reloading',
  'success',
  'rollback',
  'failed',
];

/** Terminal states reject further transitions. */
const TERMINAL: ReadonlySet<SwUpdateState> = new Set(['success', 'rollback', 'failed']);

/** Allowed transitions keyed by current state -> event -> next state. */
const TRANSITIONS: Record<
  SwUpdateState,
  Partial<Record<SwUpdateEventType, SwUpdateState>>
> = {
  checking: {
    UPDATE_FOUND: 'available',
    NO_UPDATE: 'success',
    CHECK_FAIL: 'failed',
    ROLLBACK: 'rollback',
    FAIL: 'failed',
  },
  available: {
    SAVING_START: 'saving-drafts',
    UPDATE_FOUND: 'available',
    ROLLBACK: 'rollback',
    FAIL: 'failed',
  },
  'saving-drafts': {
    DRAFTS_SAVED: 'activating',
    SAVE_FAILED: 'failed',
    ROLLBACK: 'rollback',
    FAIL: 'failed',
  },
  activating: {
    ACTIVATED: 'reloading',
    ACTIVATION_FAILED: 'rollback',
    ROLLBACK: 'rollback',
    FAIL: 'failed',
  },
  reloading: {
    RELOADED: 'success',
    RELOAD_FAILED: 'rollback',
    ROLLBACK: 'rollback',
    FAIL: 'failed',
  },
  // Terminal states: no outgoing transitions.
  success: {},
  rollback: {},
  failed: {},
};

/** Whether `event` may fire from state `from`. */
export function isValidTransition(
  from: SwUpdateState,
  event: SwUpdateEventType,
): boolean {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS[from], event);
}

/** The state reached from `from` on `event`, or null when the transition is invalid. */
export function nextState(
  from: SwUpdateState,
  event: SwUpdateEventType,
): SwUpdateState | null {
  return TRANSITIONS[from][event] ?? null;
}

export interface SwUpdateStateMachine {
  /** Current state. */
  getState(): SwUpdateState;
  /**
   * Fires an event and returns the resulting state. Invalid or terminal
   * transitions are ignored (state unchanged) — safe for production wiring.
   */
  dispatch(event: SwUpdateEventType | SwUpdateEvent): SwUpdateState;
  /** Whether the machine has reached a terminal state. */
  isTerminal(): boolean;
  /** Last failure reason carried by a `FAIL`/`SAVE_FAILED` event (diagnostics). */
  readonly reason?: string;
}

/** Creates a fresh machine starting in `checking` (or the given initial state). */
export function createSwUpdateStateMachine(
  initial: SwUpdateState = 'checking',
): SwUpdateStateMachine {
  let state: SwUpdateState = initial;
  let reason: string | undefined;

  return {
    getState: () => state,
    isTerminal: () => TERMINAL.has(state),
    dispatch(event) {
      const type = typeof event === 'string' ? event : event.type;
      if (typeof event !== 'string') {
        reason = event.reason ?? reason;
      }
      if (TERMINAL.has(state)) {
        return state;
      }
      const next = nextState(state, type);
      if (next === null) {
        return state;
      }
      state = next;
      return state;
    },
    // Expose the last failure reason for diagnostics.
    get reason(): string | undefined {
      return reason;
    },
  };
}