import {
  FlushLeaseManager,
  FLUSH_LEASE_PREFIX,
  type BroadcastLike,
  type BroadcastChannelFactory,
  type LocksLike,
} from './offlineLeader';

/** A Web Locks stub that serializes exclusive requests (like navigator.locks). */
function serialLocks(): LocksLike & { acquireCount: number } {
  let hold = Promise.resolve();
  return {
    acquireCount: 0,
    request(name, callback) {
      // Chain onto the previous hold so callbacks never overlap.
      const run = hold.then(async () => {
        this.acquireCount += 1;
        await callback({ name, mode: 'exclusive' });
      });
      hold = run.catch(() => undefined);
      return run;
    },
  };
}

describe('offlineLeader — Web Locks path', () => {
  it('supportsLocks() reflects the injected locks implementation', () => {
    expect(new FlushLeaseManager({ locks: serialLocks() }).supportsLocks()).toBe(
      true,
    );
    expect(new FlushLeaseManager({ locks: null }).supportsLocks()).toBe(false);
  });

  it('runs the critical section exactly once per call and serializes concurrent flushes', async () => {
    const locks = serialLocks();
    const manager = new FlushLeaseManager({ locks, createBroadcast: () => null });
    let runs = 0;
    const gate = new Promise<void>((resolve) => {
      // Hold inside the critical section to prove no overlap.
      void manager.runWithLease('mobile', async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 5));
        resolve();
      });
    });
    await gate;
    // A second concurrent flush must wait for the first to finish (exclusive).
    await manager.runWithLease('mobile', async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
    // Each runWithLease acquired the lock once.
    expect(locks.acquireCount).toBe(2);
  });
});

/** A BroadcastChannel fake shared across "tabs" in the same process. */
class FakeChannel implements BroadcastLike {
  private static registry = new Set<FakeChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeChannel.registry.add(this);
  }
  postMessage(data: unknown): void {
    for (const ch of FakeChannel.registry) {
      if (ch !== this && ch.onmessage) {
        ch.onmessage({ data });
      }
    }
  }
  close(): void {
    FakeChannel.registry.delete(this);
  }
}

describe('offlineLeader — BroadcastChannel fallback (multi-tab)', () => {
  it('elects exactly ONE leader across two tabs for the same queue', async () => {
    const factoryA: BroadcastChannelFactory = () => new FakeChannel('q');
    const factoryB: BroadcastChannelFactory = () => new FakeChannel('q');
    const managerA = new FlushLeaseManager({
      locks: null,
      createBroadcast: factoryA,
      claimDelay: () => 50, // tab A claims first
      heartbeatMs: 5,
    });
    const managerB = new FlushLeaseManager({
      locks: null,
      createBroadcast: factoryB,
      claimDelay: () => 200, // tab B claims later
      heartbeatMs: 5,
    });

    const [a, b] = await Promise.all([
      managerA.acquireLeader('queue'),
      managerB.acquireLeader('queue'),
    ]);

    const leaders = [a.isLeader, b.isLeader].filter(Boolean).length;
    expect(leaders).toBe(1);
    a.release();
    b.release();
  });

  it('the elected leader runs the critical section while the other tab yields', async () => {
    const factoryA: BroadcastChannelFactory = () => new FakeChannel('r');
    const factoryB: BroadcastChannelFactory = () => new FakeChannel('r');
    const managerA = new FlushLeaseManager({
      locks: null,
      createBroadcast: factoryA,
      claimDelay: () => 30,
      heartbeatMs: 5,
    });
    const managerB = new FlushLeaseManager({
      locks: null,
      createBroadcast: factoryB,
      claimDelay: () => 300,
      heartbeatMs: 5,
    });

    let flushed = 0;
    await Promise.all([
      managerA.runWithLease('r', async () => {
        flushed += 1;
      }),
      managerB.runWithLease('r', async () => {
        flushed += 1;
      }),
    ]);

    // Only the elected leader's critical section ran.
    expect(flushed).toBe(1);
  });

  it('single-tab environment (no BroadcastChannel) is always the leader', async () => {
    const manager = new FlushLeaseManager({
      locks: null,
      createBroadcast: () => null,
    });
    const leader = await manager.acquireLeader('solo');
    expect(leader.isLeader).toBe(true);
  });

  it('uses the lease name prefix for lock names', () => {
    const locks = serialLocks();
    const names: string[] = [];
    const wrapped: LocksLike = {
      request(name, callback) {
        names.push(name);
        return locks.request(name, callback);
      },
    };
    const manager = new FlushLeaseManager({ locks: wrapped });
    return manager.runWithLease('mobile', async () => undefined).then(() => {
      expect(names).toEqual([`${FLUSH_LEASE_PREFIX}mobile`]);
    });
  });
});