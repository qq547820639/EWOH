import {
  inferInputMode,
  isEditableTarget,
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
    it('matches plain keys outside editable targets', () => {
      expect(matchShortcut({ key: 'f', target: { tagName: 'DIV' } })).toBe('focus-filter');
      expect(matchShortcut({ key: 'r', target: { tagName: 'BODY' } })).toBe('refresh');
    });
    it('returns null for unknown keys', () => {
      expect(matchShortcut({ key: 'x' })).toBeNull();
    });
    it('exempts bare-key shortcuts while typing in inputs (R2-CP2-001)', () => {
      // 筛选框内输入 f/r/s 不应触发聚焦/刷新/保存视图等动作
      expect(matchShortcut({ key: 'f', target: { tagName: 'INPUT' } })).toBeNull();
      expect(matchShortcut({ key: 'r', target: { tagName: 'input' } })).toBeNull();
      expect(matchShortcut({ key: 's', target: { tagName: 'TEXTAREA' } })).toBeNull();
      expect(matchShortcut({ key: 'f', target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
    });
    it('isEditableTarget recognizes select and non-element targets', () => {
      expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
      expect(isEditableTarget(null)).toBe(false);
      expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
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