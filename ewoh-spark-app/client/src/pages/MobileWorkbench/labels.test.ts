import {
  orderStatusLabel,
  pendingActionLabel,
  pendingStatusLabel,
  pendingStatusVariant,
  qualityResultLabel,
  scanTypeLabel,
  stepStatusLabel,
} from './labels';
import type { StoredPendingAction } from '../../lib/offlineDb';

describe('mobile workbench labels', () => {
  it('maps execution, order, pending, scan and quality labels', () => {
    expect(stepStatusLabel('in_progress')).toBe('进行中');
    expect(orderStatusLabel('released')).toBe('已释放');
    expect(pendingStatusLabel('conflict')).toBe('冲突');
    expect(scanTypeLabel('station')).toBe('工位');
    expect(qualityResultLabel('rework')).toBe('返工');
  });

  it('keeps unknown business values explicit instead of hiding them', () => {
    expect(stepStatusLabel('future')).toBe('future');
    expect(orderStatusLabel('future')).toBe('future');
    expect(pendingStatusLabel('future')).toBe('future');
    expect(scanTypeLabel('future')).toBe('future');
    expect(qualityResultLabel('future')).toBe('future');
  });

  it('distinguishes actionable pending states and destructive failures', () => {
    const item = {
      id: 'a',
      type: 'transition',
      action: 'report',
    } as StoredPendingAction;
    expect(pendingActionLabel(item)).toBe('报工');
    expect(pendingStatusVariant('failed')).toBe('destructive');
    expect(pendingStatusVariant('synced')).toBe('secondary');
    expect(pendingStatusVariant('queued')).toBe('outline');
  });
});
