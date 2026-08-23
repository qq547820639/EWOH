/**
 * personnelLogic.test.ts — Personnel 数据页纯逻辑测试（ADR-085，§17/§33）。
 */
import {
  RISK_LABEL,
  PERSONNEL_STATUS_OPTIONS,
  PERSONNEL_STATUS_LABEL,
  riskLevelLabel,
  personStatusLabel,
  buildDeviceByPersonMap,
  canSubmitPersonnel,
  buildBindMessage,
} from './personnelLogic';
import type { DeviceNode } from './personnelLogic';

describe('personnelLogic', () => {
  describe('RISK_LABEL / PERSONNEL_STATUS_OPTIONS', () => {
    it('covers low/medium/high risk labels', () => {
      expect(RISK_LABEL.low).toBe('低风险');
      expect(RISK_LABEL.medium).toBe('中风险');
      expect(RISK_LABEL.high).toBe('高风险');
    });

    it('has three status options', () => {
      expect(PERSONNEL_STATUS_OPTIONS).toHaveLength(3);
      expect(PERSONNEL_STATUS_LABEL.available).toBe('在岗可调配');
      expect(PERSONNEL_STATUS_LABEL.busy).toBe('任务中');
      expect(PERSONNEL_STATUS_LABEL.high_load).toBe('高负荷');
    });
  });

  describe('riskLevelLabel', () => {
    it('returns Chinese label for known levels', () => {
      expect(riskLevelLabel('low')).toBe('低风险');
      expect(riskLevelLabel('high')).toBe('高风险');
    });

    it('returns dash for null/undefined', () => {
      expect(riskLevelLabel(null)).toBe('—');
      expect(riskLevelLabel(undefined)).toBe('—');
    });

    it('falls back to raw value for unknown', () => {
      expect(riskLevelLabel('critical')).toBe('critical');
    });
  });

  describe('personStatusLabel', () => {
    it('returns Chinese label for known statuses', () => {
      expect(personStatusLabel('available')).toBe('在岗可调配');
      expect(personStatusLabel('busy')).toBe('任务中');
    });

    it('returns dash for null/undefined', () => {
      expect(personStatusLabel(null)).toBe('—');
      expect(personStatusLabel(undefined)).toBe('—');
    });

    it('falls back to raw value for unknown', () => {
      expect(personStatusLabel('on_leave')).toBe('on_leave');
    });
  });

  describe('buildDeviceByPersonMap', () => {
    it('maps boundPersonId to device', () => {
      const devices: DeviceNode[] = [
        { deviceId: 'D1', boundPersonId: 'P1', online: true },
        { deviceId: 'D2', boundPersonId: 'P2', online: false },
        { deviceId: 'D3', online: true }, // no boundPersonId
      ];
      const m = buildDeviceByPersonMap(devices);
      expect(m.size).toBe(2);
      expect(m.get('P1')?.deviceId).toBe('D1');
      expect(m.get('P2')?.deviceId).toBe('D2');
      expect(m.has('P3')).toBe(false);
    });

    it('returns empty map for empty input', () => {
      expect(buildDeviceByPersonMap([]).size).toBe(0);
    });

    it('last device wins for duplicate boundPersonId', () => {
      const devices: DeviceNode[] = [
        { deviceId: 'D1', boundPersonId: 'P1' },
        { deviceId: 'D2', boundPersonId: 'P1' },
      ];
      const m = buildDeviceByPersonMap(devices);
      expect(m.get('P1')?.deviceId).toBe('D2');
    });
  });

  describe('canSubmitPersonnel', () => {
    it('true when name non-empty and not pending', () => {
      expect(canSubmitPersonnel('张三', false)).toBe(true);
    });

    it('false when name empty', () => {
      expect(canSubmitPersonnel('', false)).toBe(false);
      expect(canSubmitPersonnel('   ', false)).toBe(false);
    });

    it('false when pending', () => {
      expect(canSubmitPersonnel('张三', true)).toBe(false);
    });
  });

  describe('buildBindMessage', () => {
    it('returns bind message when deviceId provided', () => {
      expect(buildBindMessage('张三', 'EXO-001')).toBe('已为 张三 绑定外骨骼 EXO-001');
    });

    it('returns unbind message when deviceId is null', () => {
      expect(buildBindMessage('张三', null)).toBe('已解绑 张三 的外骨骼');
    });
  });
});
