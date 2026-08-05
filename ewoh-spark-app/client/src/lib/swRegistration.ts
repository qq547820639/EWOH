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

export const SW_URL = '/sw.js';
export const SW_MESSAGE_UPDATE_AVAILABLE = 'EWOH_SW_UPDATE_AVAILABLE';

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
}

function isSwSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Registers the service worker and wires the update flow. Pure decision logic
 * (`updateSafety`) is used to guard forced reloads; the browser API calls are
 * isolated behind this function so the live wiring stays thin.
 */
export function registerServiceWorker(
  options: SwRegistrarOptions = {},
): SwUpdateController {
  const controller: SwUpdateController = {
    async safeUpdate() {
      if (!isSwSupported()) {
        return { applied: false, reason: '当前环境不支持 Service Worker。' };
      }
      const registration = await navigator.serviceWorker.getRegistration(SW_URL);
      if (!registration) {
        return { applied: false, reason: '未找到已注册的 Service Worker。' };
      }
      // Persist drafts first so nothing is lost on reload.
      if (options.saveDrafts) {
        await options.saveDrafts();
      }
      const work = options.getPendingWork ? await options.getPendingWork() : { drafts: 0, pendingActions: 0 };
      const safety = updateSafety(work);
      if (!safety.safe) {
        return { applied: false, reason: safety.reason };
      }
      const waiting = registration.waiting || registration.installing;
      if (!waiting) {
        return { applied: false, reason: '没有待激活的新版本。' };
      }
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

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; version?: string } | undefined;
    if (data?.type === SW_MESSAGE_UPDATE_AVAILABLE) {
      options.onUpdateAvailable?.(data.version ?? '');
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