import {
  appendPendingAction,
  clearPendingActions,
  flushPendingQueue,
  markPendingAction,
  PENDING_ACTIONS_STORAGE_KEY,
  readPendingActions,
  removePendingAction,
  updatePendingAction,
  type StorageLike,
} from './offlineQueue';

function createStorage(initial: Record<string, string> = {}): StorageLike {
  const values = { ...initial };
  return {
    getItem: jest.fn((key: string) => values[key] ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values[key] = value;
    }),
  };
}

describe('offline pending action queue', () => {
  it('appends, reads, removes, and clears pending actions', () => {
    const storage = createStorage();

    const first = appendPendingAction(
      {
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S1',
        action: 'start',
        attachment: {
          name: 'scratch.jpg',
          contentType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
        },
      },
      storage,
    );
    expect(first).toHaveLength(1);

    appendPendingAction(
      {
        type: 'inspection',
        orderId: 'WO-1',
        stepId: 'S2',
        body: { result: 'pass' },
      },
      storage,
    );
    expect(readPendingActions(storage)).toHaveLength(2);
    expect(readPendingActions(storage)[0].attachment?.name).toBe('scratch.jpg');

    const afterRemove = removePendingAction(first[0].id, storage);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0].stepId).toBe('S2');

    clearPendingActions(storage);
    expect(readPendingActions(storage)).toEqual([]);
    expect(storage.setItem).toHaveBeenCalledWith(
      PENDING_ACTIONS_STORAGE_KEY,
      JSON.stringify([]),
    );
  });

  it('ignores corrupt or invalid queue payloads', () => {
    const storage = createStorage({
      [PENDING_ACTIONS_STORAGE_KEY]: '{not-json',
    });
    expect(readPendingActions(storage)).toEqual([]);

    const invalid = createStorage({
      [PENDING_ACTIONS_STORAGE_KEY]: JSON.stringify([
        { id: 'x', type: 'unknown', orderId: 'WO-1', stepId: 'S1' },
      ]),
    });
    expect(readPendingActions(invalid)).toEqual([]);
  });

  it('normalizes legacy payloads to local and updates status in place', () => {
    const legacy = createStorage({
      [PENDING_ACTIONS_STORAGE_KEY]: JSON.stringify([
        { id: 'x', type: 'transition', orderId: 'WO-1', stepId: 'S1' },
      ]),
    });
    expect(readPendingActions(legacy)[0].status).toBe('local');

    const storage = createStorage();
    const [item] = appendPendingAction(
      {
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S1',
        action: 'start',
      },
      storage,
    );
    const queued = markPendingAction(item.id, 'queued', undefined, storage);
    expect(queued[0].status).toBe('queued');

    const patched = updatePendingAction(
      item.id,
      { error: { code: 'X', message: 'boom', retryable: true } },
      storage,
    );
    expect(patched[0].error?.message).toBe('boom');
  });

  it('coerces unknown statuses to local instead of dropping actions', () => {
    const storage = createStorage({
      [PENDING_ACTIONS_STORAGE_KEY]: JSON.stringify([
        {
          id: 'x',
          type: 'transition',
          orderId: 'WO-1',
          stepId: 'S1',
          status: 'future-status',
        },
      ]),
    });
    const queue = readPendingActions(storage);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('local');
  });

  it('keeps flushing later items when one conflicts and one fails', async () => {
    const storage = createStorage();
    appendPendingAction(
      {
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S1',
        action: 'report',
        body: { quantity: 1 },
      },
      storage,
    );
    appendPendingAction(
      {
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S2',
        action: 'report',
      },
      storage,
    );
    appendPendingAction(
      {
        type: 'inspection',
        orderId: 'WO-1',
        stepId: 'S3',
        body: { result: 'pass' },
      },
      storage,
    );

    const syncOne = jest
      .fn()
      .mockRejectedValueOnce({
        response: { status: 409, data: { message: 'STATE_CONFLICT' } },
      })
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);

    const queue = readPendingActions(storage);
    const summary = await flushPendingQueue(syncOne, queue, storage);

    expect(summary).toEqual({
      synced: [queue[2].id],
      conflict: [queue[0].id],
      failed: [queue[1].id],
    });
    const remaining = readPendingActions(storage);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((item) => item.status)).toEqual(['conflict', 'failed']);
    expect(remaining[0].error?.code).toBe('STATE_CONFLICT');
    expect(syncOne).toHaveBeenCalledTimes(3);
  });

  it('skips failed and conflict items on auto-flush and retries them manually', async () => {
    const storage = createStorage();
    const first = appendPendingAction(
      {
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S1',
        action: 'report',
      },
      storage,
    )[0];
    const second = appendPendingAction(
      {
        type: 'transition',
        orderId: 'WO-1',
        stepId: 'S2',
        action: 'report',
      },
      storage,
    )[1];
    markPendingAction(
      first.id,
      'conflict',
      { code: 'STATE_CONFLICT' },
      storage,
    );
    markPendingAction(
      second.id,
      'failed',
      { code: 'SYNC_ERROR' },
      storage,
    );

    const syncOne = jest.fn().mockResolvedValue(undefined);
    const autoSummary = await flushPendingQueue(
      syncOne,
      readPendingActions(storage),
      storage,
    );
    expect(autoSummary.synced).toEqual([]);
    expect(syncOne).not.toHaveBeenCalled();

    const manualSummary = await flushPendingQueue(
      syncOne,
      readPendingActions(storage),
      storage,
      { includeManual: true },
    );
    expect(manualSummary.synced).toHaveLength(2);
    expect(syncOne).toHaveBeenCalledTimes(2);
  });
});
