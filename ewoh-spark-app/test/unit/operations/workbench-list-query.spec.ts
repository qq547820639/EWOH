import {
  parseWorkbenchListQuery,
  queryWorkbenchList,
} from '../../../server/modules/operations/workbench-list-query';

const columns = [
  { key: 'name', label: '名称' },
  { key: 'status', label: '状态' },
  { key: 'priority', label: '优先级' },
];

const rows = [
  { name: '装配', status: 'in_progress', priority: 'high' },
  { name: '质检', status: 'pending', priority: 'low' },
  { name: '包装', status: 'completed', priority: 'medium' },
  { name: '测试', status: 'in_progress', priority: 'critical' },
];

describe('workbench-list-query (服务端分页/筛选/排序)', () => {
  describe('parseWorkbenchListQuery', () => {
    it('defaults to page 1 / pageSize 20 / asc and computes offset', () => {
      const q = parseWorkbenchListQuery({});
      expect(q.page).toBe(1);
      expect(q.pageSize).toBe(20);
      expect(q.offset).toBe(0);
      expect(q.sortDir).toBe('asc');
      expect(q.filter).toBe('');
    });

    it('clamps page size to the server max (100) and page >= 1', () => {
      expect(parseWorkbenchListQuery({ pageSize: 9999 }).pageSize).toBe(100);
      expect(parseWorkbenchListQuery({ page: 0 }).page).toBe(1);
      expect(parseWorkbenchListQuery({ page: 2, pageSize: 5 }).offset).toBe(5);
    });

    it('caps filter length to avoid unbounded queries', () => {
      const q = parseWorkbenchListQuery({ filter: 'x'.repeat(500) });
      expect(q.filter.length).toBe(120);
    });

    it('rejects invalid sort direction, falling back to asc', () => {
      expect(parseWorkbenchListQuery({ sortDir: 'sideways' as never }).sortDir).toBe('asc');
      expect(parseWorkbenchListQuery({ sortDir: 'desc' }).sortDir).toBe('desc');
    });
  });

  describe('queryWorkbenchList', () => {
    it('filters across columns, sorts, and paginates with hasMore', () => {
      const q = parseWorkbenchListQuery({ page: 1, pageSize: 2, filter: 'in_progress', sortKey: 'priority', sortDir: 'asc' });
      const result = queryWorkbenchList(rows, columns, q);
      expect(result.total).toBe(2);
      expect(result.items.map((r) => r.name)).toEqual(['测试', '装配']);
      expect(result.pageSize).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it('returns hasMore true when more pages exist', () => {
      const q = parseWorkbenchListQuery({ page: 1, pageSize: 2 });
      const result = queryWorkbenchList(rows, columns, q);
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('sorts numerically in descending order', () => {
      const numeric = [
        { name: 'A', count: 3 },
        { name: 'B', count: 10 },
        { name: 'C', count: 7 },
      ];
      const q = parseWorkbenchListQuery({ sortKey: 'count', sortDir: 'desc' });
      const result = queryWorkbenchList(numeric, [{ key: 'count', label: 'c' }], q);
      expect(result.items.map((r) => r.name)).toEqual(['B', 'C', 'A']);
    });

    it('returns an empty page for a no-match filter', () => {
      const q = parseWorkbenchListQuery({ filter: 'nomatch' });
      const result = queryWorkbenchList(rows, columns, q);
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });
  });
});