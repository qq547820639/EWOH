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
  /**
   * CLI-503：跟随者侧 lease 监督。距上次收到 leader 心跳（ping/claim）
   * 超过 leaseMs 即判定 leader 失联（崩溃且未 release），选举结果过期，
   * 下一次 acquireLeader 会丢弃缓存并重新选举，允许其它 tab 接管。
   */
  isStale?: () => boolean;
  /** 丢弃该选举缓存时释放底层 channel 与定时器。 */
  dispose?: () => void;
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
      // CLI-503：lease 过期的旧选举（leader 失联）不再复用，重新发起选举，
      // 使幸存的 tab 可以接管 flush 职责。
      if (existing.isStale?.()) {
        existing.dispose?.();
        this.electors.delete(name);
      } else {
        return existing.promise;
      }
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

    // CLI-503 相关状态提升到 executor 外，供 isStale/dispose 闭包读取。
    let released = false;
    let lastSeen = this.now();

    const resultPromise = new Promise<LeaderResult>((resolve) => {
      let settled = false;
      let isLeader = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const stopHeartbeat = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };

      const teardownFollower = () => {
        released = true;
        stopHeartbeat();
        channel.close();
        if (this.electors.get(name)?.promise === resultPromise) {
          this.electors.delete(name);
        }
      };

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
          return;
        }
        if (msg.type === 'release' && settled && !isLeader) {
          // CLI-503：leader 主动释放 lease，本 tab 的跟随状态作废；
          // 下一次 acquireLeader 会重新选举（本 tab 可抢主）。
          teardownFollower();
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

    return {
      promise: resultPromise,
      // CLI-503：跟随者侧 lease 超时判定——超过 leaseMs 未收到 leader
      // 心跳（leader 崩溃且未 release）即视为过期，允许重新选举。
      isStale: () => released || this.now() - lastSeen > this.leaseMs,
      dispose: () => {
        if (channel.onmessage) channel.onmessage = null;
        channel.close();
      },
    };
  }
}

/** Convenience singleton preconfigured for the app's default environment. */
export const flushLeaseManager = new FlushLeaseManager();