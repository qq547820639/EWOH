import {
  appendPendingAction,
  clearPendingActions,
  PENDING_ACTIONS_STORAGE_KEY,
  readPendingActions,
  removePendingAction,
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
});
