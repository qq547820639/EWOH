import {
  inferInputMode,
  matchShortcut,
  mergeScannedValue,
  touchTargetSize,
  WORKBENCH_SHORTCUTS,
} from './workbenchInput';

describe('workbenchInput (多输入方式：键盘/扫码枪/触摸/单手/工业手套)', () => {
  describe('touchTargetSize', () => {
    it('enlarges targets for glove and one-handed modes', () => {
      expect(touchTargetSize('glove')).toBe(64);
      expect(touchTargetSize('singlehand')).toBe(64);
      expect(touchTargetSize('touch')).toBe(44);
      expect(touchTargetSize('keyboard')).toBe(44);
    });
  });

  describe('inferInputMode', () => {
    it('prefers glove mode when gloves are in use', () => {
      expect(inferInputMode({ glove: true, hasTouch: false })).toBe('glove');
    });
    it('maps a coarse pointer to touch', () => {
      expect(inferInputMode({ coarsePointer: true })).toBe('touch');
    });
    it('falls back to keyboard for a fine pointer', () => {
      expect(inferInputMode({ hasTouch: false, coarsePointer: false })).toBe('keyboard');
    });
  });

  describe('mergeScannedValue', () => {
    it('appends a scanned value to the current filter', () => {
      expect(mergeScannedValue('in_progress', 'WO-100')).toBe('in_progress WO-100');
    });
    it('replaces an empty filter', () => {
      expect(mergeScannedValue('', 'WO-100')).toBe('WO-100');
    });
    it('ignores empty scans', () => {
      expect(mergeScannedValue('abc', '   ')).toBe('abc');
    });
  });

  describe('matchShortcut', () => {
    it('matches plain keys', () => {
      expect(matchShortcut({ key: 'f' })).toBe('focus-filter');
      expect(matchShortcut({ key: 'r' })).toBe('refresh');
    });
    it('returns null for unknown keys', () => {
      expect(matchShortcut({ key: 'x' })).toBeNull();
    });
    it('requires the modifier when one is declared', () => {
      const ctrlShortcut = [{ key: 's', modifier: 'ctrl' as const, action: 'save-view' }];
      expect(matchShortcut({ key: 's', ctrlKey: true }, ctrlShortcut)).toBe('save-view');
      expect(matchShortcut({ key: 's', ctrlKey: false }, ctrlShortcut)).toBeNull();
    });
  });

  it('exposes the shared workbench shortcut list', () => {
    expect(WORKBENCH_SHORTCUTS.map((s) => s.action)).toContain('focus-filter');
  });
});