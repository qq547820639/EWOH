/**
 * alertsLogic.test.ts — Alerts 数据页纯逻辑测试（ADR-086，§17/§33）。
 */
import {
  ALERT_STATUS_LABEL,
  ALERT_STATUSES,
  alertStatusLabel,
  nextAlertAction,
  isAlertActive,
} from './alertsLogic';

describe('alertsLogic', () => {
  describe('ALERT_STATUS_LABEL / ALERT_STATUSES', () => {
    it('covers all five statuses', () => {
      expect(ALERT_STATUSES).toHaveLength(5);
      for (const s of ALERT_STATUSES) {
        expect(ALERT_STATUS_LABEL[s]).toBeDefined();
      }
    });

    it('maps known statuses to Chinese labels', () => {
      expect(ALERT_STATUS_LABEL.open).toBe('待确认');
      expect(ALERT_STATUS_LABEL.closed).toBe('已关闭');
    });
  });

  describe('alertStatusLabel', () => {
    it('returns Chinese label for known statuses', () => {
      expect(alertStatusLabel('open')).toBe('待确认');
      expect(alertStatusLabel('acknowledged')).toBe('已确认');
      expect(alertStatusLabel('processing')).toBe('处置中');
      expect(alertStatusLabel('closed')).toBe('已关闭');
      expect(alertStatusLabel('reopened')).toBe('已重开');
    });

    it('returns dash for null/undefined', () => {
      expect(alertStatusLabel(null)).toBe('—');
      expect(alertStatusLabel(undefined)).toBe('—');
    });

    it('falls back to raw value for unknown', () => {
      expect(alertStatusLabel('custom')).toBe('custom');
    });
  });

  describe('nextAlertAction', () => {
    it('open → acknowledge', () => {
      expect(nextAlertAction('open')).toEqual({ label: '确认', action: 'acknowledge' });
    });

    it('acknowledged → process', () => {
      expect(nextAlertAction('acknowledged')).toEqual({ label: '处置', action: 'process' });
    });

    it('processing → close', () => {
      expect(nextAlertAction('processing')).toEqual({ label: '关闭', action: 'close' });
    });

    it('closed → reopen', () => {
      expect(nextAlertAction('closed')).toEqual({ label: '重开', action: 'reopen' });
    });

    it('null/unknown defaults to acknowledge', () => {
      expect(nextAlertAction(null)).toEqual({ label: '确认', action: 'acknowledge' });
      expect(nextAlertAction(undefined)).toEqual({ label: '确认', action: 'acknowledge' });
      expect(nextAlertAction('unknown')).toEqual({ label: '确认', action: 'acknowledge' });
    });
  });

  describe('isAlertActive', () => {
    it('open/acknowledged/processing/reopened are active', () => {
      expect(isAlertActive('open')).toBe(true);
      expect(isAlertActive('acknowledged')).toBe(true);
      expect(isAlertActive('processing')).toBe(true);
      expect(isAlertActive('reopened')).toBe(true);
    });

    it('closed is not active', () => {
      expect(isAlertActive('closed')).toBe(false);
    });

    it('null/undefined/unknown are not active', () => {
      expect(isAlertActive(null)).toBe(false);
      expect(isAlertActive(undefined)).toBe(false);
      expect(isAlertActive('custom')).toBe(false);
    });
  });
});
