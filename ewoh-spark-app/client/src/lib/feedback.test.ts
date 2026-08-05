import {
  getFeedbackConfig,
  isSoundEnabled,
  isVibrationEnabled,
  notifyCriticalFailure,
  notifyOfflineSaved,
  notifyScanSuccess,
  setFeedbackConfig,
} from './feedback';

describe('feedback (UX-001 触觉/声音反馈配置)', () => {
  afterEach(() => {
    // 恢复默认配置，避免用例间相互影响。
    setFeedbackConfig({ soundEnabled: true, vibrationEnabled: true });
  });

  it('defaults to sound and vibration enabled', () => {
    expect(isSoundEnabled()).toBe(true);
    expect(isVibrationEnabled()).toBe(true);
    expect(getFeedbackConfig()).toEqual({
      soundEnabled: true,
      vibrationEnabled: true,
    });
  });

  it('toggles sound and vibration independently', () => {
    setFeedbackConfig({ soundEnabled: false });
    expect(isSoundEnabled()).toBe(false);
    expect(isVibrationEnabled()).toBe(true);
    setFeedbackConfig({ vibrationEnabled: false });
    expect(isVibrationEnabled()).toBe(false);
  });

  it('returns a fresh defensive copy on each read', () => {
    const first = getFeedbackConfig();
    const second = getFeedbackConfig();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('notify* are safe no-ops when sound and vibration are disabled', () => {
    setFeedbackConfig({ soundEnabled: false, vibrationEnabled: false });
    expect(() => {
      notifyScanSuccess();
      notifyCriticalFailure();
      notifyOfflineSaved();
    }).not.toThrow();
  });

  it('notify* are safe no-ops even when enabled (and remain callable)', () => {
    expect(() => {
      notifyScanSuccess();
      notifyCriticalFailure();
      notifyOfflineSaved();
    }).not.toThrow();
  });
});