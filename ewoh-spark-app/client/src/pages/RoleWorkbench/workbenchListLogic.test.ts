import type { ListDefinition } from './roleSchema';
import {
  buildCsv,
  detectListError,
  parseSavedView,
  resolveRowPath,
  serializeSavedView,
  stableRowId,
} from './workbenchListLogic';

const deviceList: ListDefinition = {
  key: 'abnormalDevices',
  label: '异常设备',
  emptyText: '暂无异常设备。',
  columns: [
    { key: 'name', label: '设备' },
    { key: 'status', label: '状态' },
    { key: 'entityId', label: '设备 ID', link: { to: '/devices' } },
  ],
  rowTo: '/devices',
};

describe('workbenchListLogic (TR-9.3 列表行为)', () => {
  describe('detectListError (列表错误)', () => {
    it('flags missing or wrong-shaped list payloads', () => {
      expect(detectListError(undefined, false)).toBe(true);
      expect(detectListError(null, false)).toBe(true);
      expect(detectListError({}, false)).toBe(true);
      expect(detectListError([], false)).toBe(false);
    });

    it('accepts any raw value when a transform is present', () => {
      expect(detectListError({ running: 3 }, true)).toBe(false);
      expect(detectListError(undefined, true)).toBe(true);
    });
  });

  describe('stableRowId (稳定业务 ID 作 React key)', () => {
    it('prefers a business id over the array index', () => {
      const row = { entityId: 'D-7', name: '外骨骼' };
      expect(stableRowId(row, deviceList, 3)).toBe('entityId:D-7');
    });

    it('falls back to the first defined column value, then index', () => {
      expect(stableRowId({ name: 'A' }, deviceList, 1)).toBe('name:A');
      expect(stableRowId({}, deviceList, 9)).toBe('row:9');
    });
  });

  describe('resolveRowPath (行点击跳转到具体实体路径)', () => {
    it('deep-links to the specific entity, not one static path', () => {
      expect(resolveRowPath(deviceList, { entityId: 'D-7' })).toBe('/devices/D-7');
      expect(resolveRowPath(deviceList, { entityId: 'D-42' })).toBe('/devices/D-42');
    });

    it('falls back to the static rowTo when no entity id is present', () => {
      expect(resolveRowPath(deviceList, { name: 'X' })).toBe('/devices');
    });

    it('returns null when neither a link nor rowTo is configured', () => {
      const plain: ListDefinition = {
        key: 'k',
        label: 'L',
        emptyText: '',
        columns: [{ key: 'name', label: '名称' }],
      };
      expect(resolveRowPath(plain, { name: 'A' })).toBeNull();
    });
  });

  describe('buildCsv (服务端风格导出缓冲)', () => {
    it('builds a BOM CSV with quoted header and rows', () => {
      const csv = buildCsv(deviceList, [
        { name: '装配机械臂', status: 'fault', entityId: 'A-1' },
        { name: '质检台', status: 'idle', entityId: 'Q-2' },
      ]);
      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain('设备,状态,设备 ID');
      expect(csv).toContain('"装配机械臂","fault","A-1"');
      expect(csv).toContain('"质检台","idle","Q-2"');
    });

    it('escapes embedded quotes', () => {
      const csv = buildCsv(
        { key: 'k', label: 'L', emptyText: '', columns: [{ key: 'name', label: '名称' }] },
        [{ name: '先生 "A"' }],
      );
      expect(csv).toContain('"先生 ""A"""');
    });
  });

  describe('saved view (保存视图序列化)', () => {
    it('round-trips a saved view through JSON', () => {
      const view = { filter: 'fault', sortKey: 'count', sortDir: 'desc' as const, limit: 25 };
      expect(parseSavedView(serializeSavedView(view))).toEqual(view);
    });

    it('returns null for empty or malformed input', () => {
      expect(parseSavedView(null)).toBeNull();
      expect(parseSavedView('not-json')).toBeNull();
    });
  });
});