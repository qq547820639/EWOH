import {
  riskStates,
  riskToken,
  riskTokens,
  semanticStatuses,
  semanticTokens,
  zScale,
} from './designTokens';

describe('designTokens（语义化设计 token 系统）', () => {
  it('exposes all four semantic statuses with color + foreground', () => {
    expect(semanticStatuses).toEqual(['success', 'warning', 'danger', 'info']);
    for (const status of semanticStatuses) {
      expect(semanticTokens[status]).toMatch(/^hsl\(/);
      expect(semanticTokens[`${status}Foreground` as keyof typeof semanticTokens]).toMatch(/^hsl\(/);
    }
  });

  it('exposes all six risk states with color/foreground/soft/border dimensions', () => {
    expect(riskStates).toEqual(['normal', 'degraded', 'offline', 'blocked', 'conflict', 'unknown']);
    for (const state of riskStates) {
      const t = riskTokens[state];
      expect(t.color).toMatch(/^hsl\(/);
      expect(t.foreground).toMatch(/^hsl\(/);
      expect(t.soft).toMatch(/^hsl\(/);
      expect(t.border).toMatch(/^hsl\(/);
    }
  });

  it('preserves business risk semantics (normal=green, blocked=red, unknown=gray)', () => {
    expect(riskTokens.normal.color).toBe('hsl(130 54% 42%)');
    expect(riskTokens.blocked.color).toBe('hsl(2 84% 62%)');
    expect(riskTokens.unknown.color).toBe('hsl(220 9% 46%)');
  });

  it('riskToken() returns the requested state and falls back to unknown', () => {
    expect(riskToken('blocked')).toBe(riskTokens.blocked);
    expect(riskToken(undefined)).toBe(riskTokens.unknown);
    // @ts-expect-error 非法状态编译期应被拦截，运行时回退 unknown
    expect(riskToken('bogus')).toBe(riskTokens.unknown);
  });

  it('exposes a monotonic z-index scale', () => {
    const values = Object.values(zScale).map(Number);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
    expect(zScale.modal).toBe('200');
  });
});