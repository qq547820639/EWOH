/**
 * scaleLogic.test.ts — Scale 数据页纯逻辑测试（ADR-088，§17/§33）。
 */
import {
  DIFF_CATEGORY_OPTIONS,
  formatScaleTime,
  parseJsonValue,
  diffCategoryLabel,
  isValidFactoryName,
  serializeDiffValue,
} from './scaleLogic';

describe('scaleLogic', () => {
  describe('DIFF_CATEGORY_OPTIONS', () => {
    it('has four entries', () => {
      expect(DIFF_CATEGORY_OPTIONS).toHaveLength(4);
      expect(DIFF_CATEGORY_OPTIONS.map((o) => o.value)).toEqual([
        'general', 'configuration', 'process', 'behavior',
      ]);
    });
  });

  describe('formatScaleTime', () => {
    it('formats ISO timestamp', () => {
      const result = formatScaleTime('2026-08-16T08:00:00.000Z');
      expect(result).toContain('16');
      expect(result).toContain(':');
    });

    it('returns dash for null/undefined/empty', () => {
      expect(formatScaleTime(null)).toBe('—');
      expect(formatScaleTime(undefined)).toBe('—');
      expect(formatScaleTime('')).toBe('—');
    });
  });

  describe('parseJsonValue', () => {
    it('parses valid JSON', () => {
      expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 });
      expect(parseJsonValue('[1,2,3]')).toEqual([1, 2, 3]);
      expect(parseJsonValue('"hello"')).toBe('hello');
      expect(parseJsonValue('42')).toBe(42);
      expect(parseJsonValue('true')).toBe(true);
      expect(parseJsonValue('null')).toBeNull();
    });

    it('returns raw string for invalid JSON', () => {
      expect(parseJsonValue('not json')).toBe('not json');
      expect(parseJsonValue('{invalid')).toBe('{invalid');
      expect(parseJsonValue('')).toBe('');
    });
  });

  describe('diffCategoryLabel', () => {
    it('returns Chinese label for known categories', () => {
      expect(diffCategoryLabel('general')).toBe('通用');
      expect(diffCategoryLabel('configuration')).toBe('配置');
      expect(diffCategoryLabel('process')).toBe('流程');
      expect(diffCategoryLabel('behavior')).toBe('行为');
    });

    it('falls back to raw value for unknown', () => {
      expect(diffCategoryLabel('custom')).toBe('custom');
    });
  });

  describe('isValidFactoryName', () => {
    it('accepts non-empty names within limit', () => {
      expect(isValidFactoryName('华东智造基地')).toBe(true);
      expect(isValidFactoryName('A')).toBe(true);
    });

    it('rejects empty or whitespace-only', () => {
      expect(isValidFactoryName('')).toBe(false);
      expect(isValidFactoryName('   ')).toBe(false);
    });

    it('rejects names over 100 chars', () => {
      expect(isValidFactoryName('A'.repeat(101))).toBe(false);
      expect(isValidFactoryName('A'.repeat(100))).toBe(true);
    });
  });

  describe('serializeDiffValue', () => {
    it('passes strings through', () => {
      expect(serializeDiffValue('hello')).toBe('hello');
      expect(serializeDiffValue('')).toBe('');
    });

    it('serializes objects to JSON', () => {
      expect(serializeDiffValue({ a: 1 })).toBe('{"a":1}');
      expect(serializeDiffValue([1, 2])).toBe('[1,2]');
    });

    it('serializes primitives', () => {
      expect(serializeDiffValue(42)).toBe('42');
      expect(serializeDiffValue(true)).toBe('true');
    });
  });
});
