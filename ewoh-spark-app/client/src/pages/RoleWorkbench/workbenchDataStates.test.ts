import {
  collectAvailabilityStats,
  isMetricAvailability,
  resolvePageHealth,
  resolveWorkbenchListState,
  workbenchListStateDescription,
  workbenchListStateTitle,
  type MetricAvailability,
} from './workbenchDataStates';

const availability = (status: MetricAvailability['status']): MetricAvailability => ({
  value: null,
  status,
  calculatedAt: new Date().toISOString(),
  dataRange: { from: 'now-90d', to: 'now' },
  source: 'ewoh_event',
});

describe('workbenchDataStates (数据页状态区分)', () => {
  describe('isMetricAvailability', () => {
    it('recognises backend availability markers by status field', () => {
      expect(isMetricAvailability(availability('no_data'))).toBe(true);
      expect(isMetricAvailability(availability('source_unavailable'))).toBe(true);
      expect(isMetricAvailability(availability('permission_denied'))).toBe(true);
    });

    it('rejects plain values, arrays, null and unknown shapes', () => {
      expect(isMetricAvailability(null)).toBe(false);
      expect(isMetricAvailability(undefined)).toBe(false);
      expect(isMetricAvailability(42)).toBe(false);
      expect(isMetricAvailability([1, 2])).toBe(false);
      expect(isMetricAvailability({ value: 1, source: 'x' })).toBe(false);
      expect(isMetricAvailability({ status: 'ok', source: 'x' })).toBe(false);
    });
  });

  describe('resolveWorkbenchListState', () => {
    it('first load before any data is loading', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: true,
          isError: false,
          isFetching: false,
          hasData: false,
          total: 0,
        }),
      ).toBe('loading');
    });

    it('request failure is error', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: true,
          isFetching: false,
          hasData: false,
          total: 0,
        }),
      ).toBe('error');
    });

    it('availability marker wins over rows (no_data vs empty distinction)', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: false,
          isFetching: false,
          hasData: true,
          total: 0,
          availability: availability('no_data'),
        }),
      ).toBe('no_data');
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: false,
          isFetching: false,
          hasData: true,
          total: 0,
          availability: availability('source_unavailable'),
        }),
      ).toBe('source_unavailable');
    });

    it('empty result (ok, zero rows) is empty, distinct from no_data', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: false,
          isFetching: false,
          hasData: true,
          total: 0,
          apiStatus: 'ok',
        }),
      ).toBe('empty');
    });

    it('non-ok apiStatus is treated as error', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: false,
          isFetching: false,
          hasData: false,
          total: 0,
          apiStatus: 'degraded',
        }),
      ).toBe('error');
    });

    it('background refresh with data is refreshing', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: false,
          isFetching: true,
          hasData: true,
          total: 5,
          apiStatus: 'ok',
        }),
      ).toBe('refreshing');
    });

    it('healthy loaded list is ok', () => {
      expect(
        resolveWorkbenchListState({
          isLoading: false,
          isError: false,
          isFetching: false,
          hasData: true,
          total: 5,
          apiStatus: 'ok',
        }),
      ).toBe('ok');
    });
  });

  describe('labels', () => {
    it('provides distinct titles and descriptions for each non-ok state', () => {
      expect(workbenchListStateTitle('no_data')).toBe('暂无业务数据');
      expect(workbenchListStateTitle('not_configured')).toBe('未配置数据源');
      expect(workbenchListStateTitle('permission_denied')).toBe('无查看权限');
      expect(workbenchListStateTitle('source_unavailable')).toBe('数据源暂不可用');
      expect(workbenchListStateTitle('stale')).toBe('数据已过期');
      expect(workbenchListStateTitle('empty')).toBe('暂无数据');
      expect(workbenchListStateDescription('no_data')).toContain('业务数据');
      expect(workbenchListStateDescription('permission_denied')).toContain('权限');
    });
  });

  describe('page health', () => {
    it('is ok when no availability markers exist', () => {
      expect(resolvePageHealth([])).toBe('ok');
      expect(resolvePageHealth(collectAvailabilityStats({ a: 1, b: [1, 2] }))).toBe('ok');
    });

    it('degrades when a data source is unavailable', () => {
      expect(resolvePageHealth(['no_data', 'source_unavailable'])).toBe('degraded');
    });

    it('is partial for other availability statuses', () => {
      expect(resolvePageHealth(['no_data', 'permission_denied'])).toBe('partial');
    });
  });
});