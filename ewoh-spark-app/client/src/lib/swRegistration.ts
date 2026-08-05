/**
 * Service-worker registration + update experience for the page side.
 *
 * Complements the pure cache/update logic in `swCache.ts`. This module owns the
 * page-side wiring: registering `/sw.js`, surfacing a new-version notice, and
 * giving the user an explicit choice between "稍后更新" (defer) and "安全更新"
 * (apply after saving drafts / confirming no pending work). The safety checks are
 * pure and unit-testable; the live registration is a thin adapter over the
 * browser ServiceWorker API.
 */
import { shouldServeContract, API_CONTRACT_VERSION } from './swCache';
import { recordMetric } from './observability';
import {
  createSwUpdateStateMachine,
  type SwUpdateStateMachine,
} from './swUpdateStateMachine';

export const SW_URL = '/sw.js';
export const SW_MESSAGE_UPDATE_AVAILABLE = 'EWOH_SW_UPDATE_AVAILABLE';

/** Lifecycle messages the service worker posts back to the page for metrics. */
export const SW_MESSAGE_INSTALLED = 'EWOH_SW_INSTALLED';
export const SW_MESSAGE_ACTIVATED = 'EWOH_SW_ACTIVATED';
export const SW_MESSAGE_ROLLBACK = 'EWOH_SW_ROLLBACK';

/** Report a `sw.*` observability metric (setup/activate/failure/rollback/migration). */
function reportSwMetric(
  name: string,
  value: number,
  tags?: Record<string, string | number | boolean>,
): void {
  recordMetric(`sw.${name}`, value, tags);
}

export interface PendingWork {
  drafts: number;
  pendingActions: number;
}

/** Whether there is unsaved draft or unsynced work that forbids a forced reload. */
export function hasPendingWork(work: PendingWork): boolean {
  return work.drafts > 0 || work.pendingActions > 0;
}

export interface UpdateSafety {
  safe: boolean;
  reason: string;
}

/**
 * Decides whether we may apply an update immediately. A forced reload is blocked
 * whenever there are unsaved drafts or unsynced actions; the returned reason is
 * surfaced to the user ("展示影响").
 */
export function updateSafety(work: PendingWork): UpdateSafety {
  if (work.pendingActions > 0 && work.drafts > 0) {
    return {
      safe: false,
      reason: `有 ${work.drafts} 份未保存草稿和 ${work.pendingActions} 项未同步操作，请先处理后再更新。`,
    };
  }
  if (work.pendingActions > 0) {
    return {
      safe: false,
      reason: `有 ${work.pendingActions} 项未同步操作，更新前将先尝试同步。`,
    };
  }
  if (work.drafts > 0) {
    return {
      safe: false,
      reason: `有 ${work.drafts} 份未保存草稿，更新前将先保存草稿。`,
    };
  }
  return { safe: true, reason: '' };
}

export interface UpdateDecision {
  applied: boolean;
  reason: string;
}

export interface SwRegistrarOptions {
  /** Called when a new SW version is installed and waiting to activate. */
  onUpdateAvailable?: (version: string) => void;
  /** Called when the recorded server contract is incompatible (fail-closed). */
  onContractMismatch?: (serverVersion: string) => void;
  /** Reads pending work so a forced reload is not performed while dirty. */
  getPendingWork?: () => Promise<PendingWork>;
  /** Persists drafts before applying an update. */
  saveDrafts?: () => Promise<void>;
}

export interface SwUpdateController {
  /** "安全更新": save drafts, then activate the waiting worker on success. */
  safeUpdate(): Promise<UpdateDecision>;
  /** "稍后更新": leave the waiting worker idle; it activates on next reload. */
  deferUpdate(): void;
  /** Current state of the update flow state machine (diagnostics). */
  getState(): string;
}

function isSwSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Registers the service worker and wires the update flow. Pure decision logic
 * (`updateSafety`) is used to guard forced reloads; the browser API calls are
 * isolated behind this function so the live wiring stays thin. The flow is
 * driven through an explicit, unit-testable state machine
 * (`createSwUpdateStateMachine`), and every step that can fail is reported as a
 * `sw.*` observability metric.
 */
export function registerServiceWorker(
  options: SwRegistrarOptions = {},
): SwUpdateController {
  const machine: SwUpdateStateMachine = createSwUpdateStateMachine();

  const controller: SwUpdateController = {
    getState: () => machine.getState(),
    async safeUpdate() {
      if (!isSwSupported()) {
        machine.dispatch({ type: 'FAIL', reason: 'unsupported' });
        reportSwMetric('update.failed', 1, { reason: 'unsupported' });
        return { applied: false, reason: '当前环境不支持 Service Worker。' };
      }
      const registration = await navigator.serviceWorker.getRegistration(SW_URL);
      if (!registration) {
        machine.dispatch({ type: 'FAIL', reason: 'no-registration' });
        reportSwMetric('update.failed', 1, { reason: 'no-registration' });
        return { applied: false, reason: '未找到已注册的 Service Worker。' };
      }
      // 更新前先持久化草稿与离线队列；保存失败则中止，绝不进入 activating。
      machine.dispatch('SAVING_START');
      if (options.saveDrafts) {
        try {
          await options.saveDrafts();
        } catch {
          machine.dispatch({ type: 'SAVE_FAILED', reason: 'save-drafts' });
          reportSwMetric('update.failed', 1, { reason: 'save-drafts' });
          return { applied: false, reason: '草稿/离线队列保存失败，已中止更新。' };
        }
      }
      const work = options.getPendingWork ? await options.getPendingWork() : { drafts: 0, pendingActions: 0 };
      const safety = updateSafety(work);
      if (!safety.safe) {
        machine.dispatch({ type: 'FAIL', reason: 'safety' });
        reportSwMetric('update.failed', 1, { reason: 'safety' });
        return { applied: false, reason: safety.reason };
      }
      // 草稿与离线队列已安全持久化 → 进入 activating。
      machine.dispatch('DRAFTS_SAVED');
      const waiting = registration.waiting || registration.installing;
      if (!waiting) {
        machine.dispatch({ type: 'FAIL', reason: 'no-waiting' });
        reportSwMetric('update.failed', 1, { reason: 'no-waiting' });
        return { applied: false, reason: '没有待激活的新版本。' };
      }
      machine.dispatch('ACTIVATING');
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return { applied: true, reason: '' };
    },
    deferUpdate() {
      // Do nothing: the waiting worker stays idle and will activate on the next
      // full reload (new page / close-and-reopen), never forcibly while the user
      // is mid-task.
    },
  };

  if (!isSwSupported()) {
    return controller;
  }

  navigator.serviceWorker.register(SW_URL, { scope: '/' }).then(
    (registration) => {
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) {
          return;
        }
        // A new version is being checked for / installed.
        machine.dispatch('UPDATE_FOUND');
        newWorker.addEventListener('statechange', () => {
          // A new version is installed and waiting while a controller already
          // exists — surface the notice so the user can choose to apply it.
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            options.onUpdateAvailable?.(/* version unknown here */ '');
          }
        });
      });
    },
    () => {
      // Registration failure is non-fatal; the app still works online.
    },
  );

  // The waiting worker taking control means the new shell activated successfully.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    machine.dispatch('ACTIVATED');
    reportSwMetric('activate', 1);
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as
      | { type?: string; version?: string; from?: string; to?: string; removed?: string[] }
      | undefined;
    if (data?.type === SW_MESSAGE_UPDATE_AVAILABLE) {
      options.onUpdateAvailable?.(data.version ?? '');
      return;
    }
    // SW lifecycle events -> observability metrics (sw.*).
    if (data?.type === SW_MESSAGE_INSTALLED) {
      reportSwMetric('install', 1, { version: data.version ?? '' });
      return;
    }
    if (data?.type === SW_MESSAGE_ACTIVATED) {
      reportSwMetric('activate', 1, { version: data.version ?? '' });
      // Cache migration cleanup report: number of stale caches pruned.
      if (Array.isArray(data.removed) && data.removed.length > 0) {
        reportSwMetric('migration', data.removed.length, {
          version: data.version ?? '',
          removed: data.removed.join(','),
        });
      }
      return;
    }
    if (data?.type === SW_MESSAGE_ROLLBACK) {
      machine.dispatch('ROLLBACK');
      reportSwMetric('rollback', 1, { from: data.from ?? '', to: data.to ?? '' });
    }
  });

  return controller;
}

/**
 * Fail-closed gate for the UI: with an explicitly recorded server contract we ask
 * `shouldServeContract`; with no server version we refuse to claim compatibility.
 */
export function contractStatus(serverVersion: string | null):
  | { ok: true }
  | { ok: false; server: string } {
  if (!shouldServeContract(API_CONTRACT_VERSION, serverVersion)) {
    return { ok: false, server: serverVersion ?? '(未知)' };
  }
  return { ok: true };
}

export { shouldServeContract, API_CONTRACT_VERSION };