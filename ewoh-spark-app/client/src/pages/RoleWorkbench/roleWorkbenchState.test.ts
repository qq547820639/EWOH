import type { ListDefinition } from './roleSchema';
import {
  LEGACY_VIEW_PREFIX,
  buildFilterParams,
  buildPageParams,
  buildRoleParams,
  buildSortParams,
  defaultListState,
  parseLegacyViewKey,
  readListStates,
  serverViewKey,
} from './roleWorkbenchState';

const lists: ListDefinition[] = [
  { key: 'mySteps', label: '我的工序', emptyText: '', columns: [] },
  { key: 'delayedOrders', label: '延迟工单', emptyText: '', columns: [] },
];

describe('roleWorkbenchState (页面查询状态建模)', () => {
  describe('readListStates (URL → 查询状态)', () => {
    it('reads filter/sort/page from URL params per list', () => {
      const params = new URLSearchParams();
      params.set('mySteps.filter', 'fault');
      params.set('mySteps.sort', 'status');
      params.set('mySteps.dir', 'desc');
      params.set('mySteps.page', '3');
      const states = readListStates(params, lists);
      expect(states.mySteps).toEqual({
        filter: 'fault',
        sort: { key: 'status', dir: 'desc' },
        page: 3,
      });
      expect(states.delayedOrders).toEqual({ filter: '', sort: undefined, page: 1 });
    });

    it('defaults to page 1 for missing/invalid pages', () => {
      const params = new URLSearchParams();
      params.set('mySteps.page', '0');
      params.set('delayedOrders.page', 'abc');
      const states = readListStates(params, lists);
      expect(states.mySteps.page).toBe(1);
      expect(states.delayedOrders.page).toBe(1);
    });

    it('sort direction defaults to asc and only honors "desc"', () => {
      const params = new URLSearchParams();
      params.set('mySteps.sort', 'count');
      params.set('mySteps.dir', 'asc');
      const states = readListStates(params, lists);
      expect(states.mySteps.sort).toEqual({ key: 'count', dir: 'asc' });
    });
  });

  describe('URL 写映射（查询 → URL，不修改入参）', () => {
    it('setFilter sets a value and resets page', () => {
      const next = buildFilterParams(new URLSearchParams({ 'mySteps.page': '4' }), 'mySteps', 'fault');
      expect(next.get('mySteps.filter')).toBe('fault');
      expect(next.get('mySteps.page')).toBe('1');
    });

    it('setFilter clears the value when empty', () => {
      const next = buildFilterParams(new URLSearchParams({ 'mySteps.filter': 'fault' }), 'mySteps', '');
      expect(next.has('mySteps.filter')).toBe(false);
    });

    it('toggleSort flips direction on the same column', () => {
      const next = buildSortParams(
        new URLSearchParams({ 'mySteps.sort': 'status', 'mySteps.dir': 'asc' }),
        'mySteps',
        'status',
      );
      expect(next.get('mySteps.sort')).toBe('status');
      expect(next.get('mySteps.dir')).toBe('desc');
    });

    it('toggleSort resets to asc on a new column', () => {
      const next = buildSortParams(
        new URLSearchParams({ 'mySteps.sort': 'status', 'mySteps.dir': 'desc' }),
        'mySteps',
        'count',
      );
      expect(next.get('mySteps.sort')).toBe('count');
      expect(next.get('mySteps.dir')).toBe('asc');
    });

    it('setPage updates only the page for the list', () => {
      const next = buildPageParams(new URLSearchParams({ 'mySteps.page': '1' }), 'mySteps', 5);
      expect(next.get('mySteps.page')).toBe('5');
    });

    it('buildRoleParams preserves other params', () => {
      const next = buildRoleParams(new URLSearchParams({ 'mySteps.filter': 'x' }), 'manager');
      expect(next.get('role')).toBe('manager');
      expect(next.get('mySteps.filter')).toBe('x');
    });
  });

  describe('serverViewKey / legacy migration', () => {
    it('builds a server view key from role and list', () => {
      expect(serverViewKey('operator', 'mySteps')).toBe('operator.mySteps');
    });

    it('parses a legacy localStorage view key', () => {
      expect(parseLegacyViewKey(`${LEGACY_VIEW_PREFIX}operator.mySteps`)).toEqual({
        role: 'operator',
        listKey: 'mySteps',
      });
    });

    it('returns null for non-legacy or unknown keys', () => {
      expect(parseLegacyViewKey('other.key')).toBeNull();
      expect(parseLegacyViewKey(`${LEGACY_VIEW_PREFIX}unknown.list`)).toBeNull();
      expect(parseLegacyViewKey(`${LEGACY_VIEW_PREFIX}operator.`)).toBeNull();
    });
  });

  describe('defaultListState', () => {
    it('returns an empty, first-page state', () => {
      expect(defaultListState()).toEqual({ filter: '', sort: undefined, page: 1 });
    });
  });
});