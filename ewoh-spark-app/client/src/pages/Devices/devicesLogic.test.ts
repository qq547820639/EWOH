/**
 * devicesLogic.test.ts — Devices 数据页纯逻辑测试（ADR-083，§17/§33）。
 */
import {
  isDataStale,
  buildDeviceSearchQuery,
  buildBatteryChartData,
  buildEntityNameMap,
  SOURCE_LABELS,
} from './devicesLogic';
import type { DeviceInfo } from '@shared/api.interface';

describe('devicesLogic', () => {
  // batteryColor 的测试已随死函数删除（2026-09-01：全仓零生产调用）。

  describe('isDataStale', () => {
    it('returns false when dataUpdatedAt is 0 (never fetched)', () => {
      expect(isDataStale(0)).toBe(false);
    });

    it('returns false when data is fresh', () => {
      expect(isDataStale(Date.now())).toBe(false);
    });

    it('returns true when data is older than staleMs', () => {
      expect(isDataStale(Date.now() - 120000)).toBe(true);
    });

    it('respects custom staleMs', () => {
      expect(isDataStale(Date.now() - 5000, 10000)).toBe(false);
      expect(isDataStale(Date.now() - 15000, 10000)).toBe(true);
    });
  });

  describe('buildDeviceSearchQuery', () => {
    it('includes orderby always', () => {
      const q = buildDeviceSearchQuery({ orderby: 'batteryDesc' });
      expect(q.orderby).toBe('batteryDesc');
    });

    it('includes keyword when non-empty', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', keyword: '  EXO  ' });
      expect(q.keyword).toBe('EXO');
    });

    it('excludes empty keyword', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', keyword: '  ' });
      expect(q.keyword).toBeUndefined();
    });

    it('maps onlineFilter to boolean', () => {
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', onlineFilter: 'online' }).online).toBe(true);
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', onlineFilter: 'offline' }).online).toBe(false);
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', onlineFilter: 'all' }).online).toBeUndefined();
    });

    it('includes battery range when set', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', batteryMin: '20', batteryMax: '80' });
      expect(q.batteryMin).toBe(20);
      expect(q.batteryMax).toBe(80);
    });

    it('excludes empty battery range', () => {
      const q = buildDeviceSearchQuery({ orderby: 'deviceId', batteryMin: '', batteryMax: '' });
      expect(q.batteryMin).toBeUndefined();
      expect(q.batteryMax).toBeUndefined();
    });

    it('includes sourceType when not all', () => {
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', sourceFilter: 'simulated' }).sourceType).toBe('simulated');
      expect(buildDeviceSearchQuery({ orderby: 'deviceId', sourceFilter: 'all' }).sourceType).toBeUndefined();
    });
  });

  describe('buildBatteryChartData', () => {
    it('transforms devices to chart data', () => {
      const devices = [
        { deviceId: 'D1', batteryPct: 80, online: true },
        { deviceId: 'D2', batteryPct: 30, online: false },
      ] as unknown as DeviceInfo[];
      const data = buildBatteryChartData(devices);
      expect(data).toEqual([
        { name: 'D1', battery: 80, online: true },
        { name: 'D2', battery: 30, online: false },
      ]);
    });

    it('returns empty array for empty input', () => {
      expect(buildBatteryChartData([])).toEqual([]);
    });
  });

  describe('buildEntityNameMap', () => {
    it('maps both entityId and id to name', () => {
      const entities = [
        { entityId: 'E1', id: 'uuid-1', name: 'Zone A' },
        { entityId: 'E2', id: 'uuid-2', name: 'Zone B' },
      ];
      const m = buildEntityNameMap(entities);
      expect(m.get('E1')).toBe('Zone A');
      expect(m.get('uuid-1')).toBe('Zone A');
      expect(m.get('E2')).toBe('Zone B');
    });
  });

  describe('SOURCE_LABELS', () => {
    it('covers known source types', () => {
      expect(SOURCE_LABELS.real).toBe('真实');
      expect(SOURCE_LABELS.simulated).toBe('仿真');
      expect(Object.keys(SOURCE_LABELS)).toContain('controlled_test');
    });
  });
});
