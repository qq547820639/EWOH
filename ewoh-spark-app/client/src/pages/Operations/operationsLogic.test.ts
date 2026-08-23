/**
 * operationsLogic.test.ts — Operations 数据页纯逻辑测试（ADR-087，§17/§33）。
 */
import {
  TABS,
  EMPTY_FLAGS,
  FLAG_LABELS,
  ASSET_CATEGORY_OPTIONS,
  TASK_TYPE_OPTIONS,
  TASK_PRIORITY_OPTIONS,
  formatOpsTime,
  countActiveFlags,
  activeFlagLabels,
  assetCategoryLabel,
  taskTypeLabel,
  taskPriorityLabel,
  calcEfficiencyPercent,
  efficiencyGrade,
} from './operationsLogic';
import type { WorkCenterFlags } from './operationsLogic';

describe('operationsLogic', () => {
  describe('constants', () => {
    it('TABS has 7 entries', () => {
      expect(TABS).toHaveLength(7);
      expect(TABS[0]).toBe('总览');
      expect(TABS[6]).toBe('人员效率');
    });

    it('EMPTY_FLAGS has all false', () => {
      expect(Object.values(EMPTY_FLAGS).every((v) => v === false)).toBe(true);
    });

    it('FLAG_LABELS covers all 8 flags', () => {
      expect(FLAG_LABELS).toHaveLength(8);
      expect(FLAG_LABELS.map((f) => f.key)).toEqual(Object.keys(EMPTY_FLAGS));
    });

    it('category/type/priority options have entries', () => {
      expect(ASSET_CATEGORY_OPTIONS.length).toBeGreaterThanOrEqual(2);
      expect(TASK_TYPE_OPTIONS.length).toBeGreaterThanOrEqual(3);
      expect(TASK_PRIORITY_OPTIONS.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('formatOpsTime', () => {
    it('formats ISO timestamp to zh-CN', () => {
      const result = formatOpsTime('2026-08-16T08:00:00.000Z');
      expect(result).toContain('16');
      expect(result).toContain(':');
    });

    it('returns dash for null/undefined/empty', () => {
      expect(formatOpsTime(null)).toBe('—');
      expect(formatOpsTime(undefined)).toBe('—');
      expect(formatOpsTime('')).toBe('—');
    });
  });

  describe('countActiveFlags / activeFlagLabels', () => {
    it('counts true flags', () => {
      const flags: WorkCenterFlags = {
        ...EMPTY_FLAGS,
        firstInspectionRequired: true,
        scanRequired: true,
      };
      expect(countActiveFlags(flags)).toBe(2);
    });

    it('returns 0 for empty flags', () => {
      expect(countActiveFlags(EMPTY_FLAGS)).toBe(0);
    });

    it('returns labels for active flags only', () => {
      const flags: WorkCenterFlags = {
        ...EMPTY_FLAGS,
        exoskeletonRequired: true,
        toolingCheckRequired: true,
      };
      expect(activeFlagLabels(flags)).toEqual(['外骨骼要求', '工装点检']);
    });
  });

  describe('category/type/priority labels', () => {
    it('assetCategoryLabel returns Chinese for known values', () => {
      expect(assetCategoryLabel('device')).toBe('设备');
      expect(assetCategoryLabel('tooling')).toBe('工装');
    });

    it('assetCategoryLabel falls back for unknown', () => {
      expect(assetCategoryLabel('custom')).toBe('custom');
    });

    it('taskTypeLabel returns Chinese for known values', () => {
      expect(taskTypeLabel('preventive')).toBe('预防性');
      expect(taskTypeLabel('corrective')).toBe('纠正性');
    });

    it('taskPriorityLabel returns Chinese for known values', () => {
      expect(taskPriorityLabel('low')).toBe('低');
      expect(taskPriorityLabel('critical')).toBe('紧急');
    });
  });

  describe('calcEfficiencyPercent / efficiencyGrade', () => {
    it('calculates efficiency percentage', () => {
      expect(calcEfficiencyPercent(90, 100)).toBe(90);
      expect(calcEfficiencyPercent(120, 100)).toBe(120);
      expect(calcEfficiencyPercent(50, 100)).toBe(50);
    });

    it('returns 0 for zero/standard=0', () => {
      expect(calcEfficiencyPercent(0, 100)).toBe(0);
      expect(calcEfficiencyPercent(100, 0)).toBe(0);
      expect(calcEfficiencyPercent(100, -1)).toBe(0);
    });

    it('grades efficiency correctly', () => {
      expect(efficiencyGrade(120)).toBe('优秀');
      expect(efficiencyGrade(100)).toBe('优秀');
      expect(efficiencyGrade(95)).toBe('良好');
      expect(efficiencyGrade(85)).toBe('良好');
      expect(efficiencyGrade(75)).toBe('一般');
      expect(efficiencyGrade(70)).toBe('一般');
      expect(efficiencyGrade(50)).toBe('需改进');
      expect(efficiencyGrade(0)).toBe('需改进');
    });
  });
});
