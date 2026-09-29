import { readPositiveIntSetting } from '../../../server/modules/shared/limit-config';

describe('readPositiveIntSetting', () => {
  it('uses the fallback for missing and blank values', () => {
    expect(readPositiveIntSetting(undefined, 300, 'X')).toBe(300);
    expect(readPositiveIntSetting('   ', 300, 'X')).toBe(300);
  });

  it('accepts positive integers used by rate-limit configuration', () => {
    expect(readPositiveIntSetting('45', 60, 'X')).toBe(45);
    expect(readPositiveIntSetting(' 12 ', 60, 'X')).toBe(12);
  });

  it('never lets NaN, decimals, zero or negatives disable a limiter', () => {
    const warnings: string[] = [];
    for (const value of ['abc', 'NaN', 'Infinity', '0', '-5', '1.5']) {
      expect(readPositiveIntSetting(value, 300, 'RATE_LIMIT_MAX', (m) => warnings.push(m))).toBe(300);
    }
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('非法 RATE_LIMIT_MAX');
  });
});
