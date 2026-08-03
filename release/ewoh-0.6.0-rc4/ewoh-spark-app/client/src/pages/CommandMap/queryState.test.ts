import {
  collectQueryErrors,
  isStaleSince,
  retryAll,
  type QueryStateSnapshot,
} from './queryState';

function snapshot(overrides: Partial<QueryStateSnapshot> = {}): QueryStateSnapshot {
  return {
    key: 'world',
    label: '世界状态',
    isError: false,
    dataUpdatedAt: 0,
    refetch: jest.fn(),
    ...overrides,
  };
}

describe('command map query state helpers', () => {
  it('collects only failed queries', () => {
    const queries = [
      snapshot({ key: 'entities', isError: true }),
      snapshot({ key: 'world' }),
      snapshot({ key: 'overview', isError: true }),
    ];
    expect(collectQueryErrors(queries).map((entry) => entry.key)).toEqual([
      'entities',
      'overview',
    ]);
  });

  it('detects stale data after the configured age', () => {
    expect(isStaleSince(0, Date.now(), 10_000)).toBe(false);
    expect(isStaleSince(Date.now() - 30_000, Date.now(), 10_000)).toBe(true);
  });

  it('refetches every failed query', () => {
    const queries = [
      snapshot({ key: 'a', isError: true }),
      snapshot({ key: 'b', isError: true }),
    ];
    retryAll(queries);
    expect(queries[0].refetch).toHaveBeenCalled();
    expect(queries[1].refetch).toHaveBeenCalled();
  });
});
