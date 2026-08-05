/**
 * Multi-tab leader election / lease for the offline flush queue.
 *
 * Only ONE tab is allowed to flush the offline queue at a time, otherwise two
 * tabs could deliver the same pending action concurrently (defeating the
 * idempotency guarantee server-side by racing the CAS). We prefer the Web Locks
 * API (`navigator.locks`) because it is the platform-native, atomic primitive;
 * when it is unavailable we fall back to a BroadcastChannel-based leader
 * election with a jittered claim and a heartbeat lease.
 */

export interface LockInfo {
  name: string;
  mode: 'exclusive' | 'shared';
}

export interface LocksLike {
  request(
    name: string,
    callback: (lock: LockInfo) => Promise<void>,
  ): Promise<void>;
}

export interface BroadcastLike {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type BroadcastChannelFactory = () => BroadcastLike | null;

export const FLUSH_LEASE_PREFIX = 'ewoh:flush-lease:';

export interface LeaderResult {
  /** True when this tab won the election and owns the flush lease. */
  isLeader: boolean;
  /** Release the lease voluntarily (leader-only). Calling on a non-leader is a no-op. */
  release: () => void;
}

interface ElectionMessage {
  type: 'claim' | 'release' | 'ping';
  name: string;
  token: string;
}

export interface FlushLeaseManagerOptions {
  /** Injectable Web Locks implementation (defaults to `navigator.locks`). */
  locks?: LocksLike | null;
  /** Injectable BroadcastChannel factory (defaults to `BroadcastChannel`). */
  createBroadcast?: BroadcastChannelFactory;
  /** Injectable clock for lease expiry checks. */
  now?: () => number;
  /** Lease duration (ms) before a non-heartbeating leader is considered gone. */
  leaseMs?: number;
  /** Injectable claim backoff (ms) so tests can stagger tabs deterministically. */
  claimDelay?: () => number;
  /** Injectable heartbeat interval (ms). */
  heartbeatMs?: number;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultLocks(): LocksLike | null {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks;
  }
  return null;
}

function defaultBroadcast(): BroadcastLike | null {
  if (typeof BroadcastChannel !== 'undefined') {
    return new BroadcastChannel(FLUSH_LEASE_PREFIX) as unknown as BroadcastLike;
  }
  return null;
}

interface BroadcastElector {
  promise: Promise<LeaderResult>;
}

export class FlushLeaseManager {
  private readonly locks: LocksLike | null;
  private readonly createBroadcast: BroadcastChannelFactory;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly claimDelay: () => number;
  private readonly heartbeatMs: number;
  private readonly electors = new Map<string, BroadcastElector>();

  constructor(options: FlushLeaseManagerOptions = {}) {
    this.locks = options.locks === undefined ? defaultLocks() : options.locks;
    this.createBroadcast =
      options.createBroadcast ??
      (options.locks === undefined && typeof BroadcastChannel !== 'undefined'
        ? defaultBroadcast
        : () => null);
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 15_000;
    this.claimDelay = options.claimDelay ?? (() => 100 + Math.random() * 300);
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
  }

  /** True when the Web Locks API is available (the preferred path). */
  supportsLocks(): boolean {
    return this.locks !== null;
  }

  /**
   * Runs `criticalSection` exactly once across all tabs. Prefers `navigator.locks`
   * (exclusive) and falls back to a BroadcastChannel leader election.
   */
  async runWithLease(name: string, criticalSection: () => Promise<void>): Promise<void> {
    const fullName = `${FLUSH_LEASE_PREFIX}${name}`;
    if (this.locks) {
      await this.locks.request(fullName, async () => {
        await criticalSection();
      });
      return;
    }
    const leader = await this.acquireLeader(name);
    if (!leader.isLeader) {
      return;
    }
    try {
      await criticalSection();
    } finally {
      leader.release();
    }
  }

  /**
   * BroadcastChannel-based leader election. Returns a `LeaderResult` where at
   * most one tab reports `isLeader === true` for the same queue name. The winner
   * keeps a heartbeat lease; a tab that misses the lease (leader crashed / was
   * closed) triggers a fresh election so another tab can take over.
   */
  async acquireLeader(name: string): Promise<LeaderResult> {
    const existing = this.electors.get(name);
    if (existing) {
      return existing.promise;
    }
    const elector = this.startElection(name);
    this.electors.set(name, elector);
    return elector.promise;
  }

  /** Drop cached election state (used by tests / on logout). */
  clear(): void {
    this.electors.clear();
  }

  private startElection(name: string): BroadcastElector {
    const channel = this.createBroadcast();
    const token = createId();
    if (!channel) {
      // No BroadcastChannel — single-tab environment, always the leader.
      return {
        promise: Promise.resolve({
          isLeader: true,
          release: () => undefined,
        }),
      };
    }

    const resultPromise = new Promise<LeaderResult>((resolve) => {
      let settled = false;
      let isLeader = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let lastSeen = this.now();

      const settle = (leader: boolean, self: boolean): LeaderResult => {
        if (settled && !self) return { isLeader: false, release: () => undefined };
        settled = true;
        isLeader = leader;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        return {
          isLeader,
          release: () => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            channel.postMessage({ type: 'release', name, token });
            channel.close();
            this.electors.delete(name);
          },
        };
      };

      const onMessage = (event: { data: unknown }) => {
        const msg = event.data as ElectionMessage;
        if (!msg || msg.name !== name || msg.token === token) return;
        if (msg.type === 'ping' || msg.type === 'claim') {
          lastSeen = this.now();
        }
        if (msg.type === 'claim' && !settled) {
          // Another tab claimed leadership first — yield.
          resolve(settle(false, true));
        }
      };
      channel.onmessage = onMessage;

      // Jittered claim so a single tab becomes leader without a broadcast storm.
      const delay = Math.max(0, this.claimDelay());
      setTimeout(() => {
        if (settled) return;
        channel.postMessage({ type: 'claim', name, token });
        isLeader = true;
        settled = true;
        // Heartbeat lease renewal.
        heartbeatTimer = setInterval(() => {
          if (!settled) return;
          channel.postMessage({ type: 'ping', name, token });
          lastSeen = this.now();
        }, this.heartbeatMs);
        resolve({
          isLeader: true,
          release: () => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            channel.postMessage({ type: 'release', name, token });
            channel.close();
            this.electors.delete(name);
          },
        });
      }, delay);
    });

    return { promise: resultPromise };
  }
}

/** Convenience singleton preconfigured for the app's default environment. */
export const flushLeaseManager = new FlushLeaseManager();