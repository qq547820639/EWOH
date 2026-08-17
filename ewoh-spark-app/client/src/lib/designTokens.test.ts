import fs from 'node:fs';
import path from 'node:path';
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

describe('designTokens ↔ tokens.css 单一来源锁定（CLI-527）', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../tokens.css'), 'utf8');
  const cssVar = (name: string): string | null => {
    const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    return match ? match[1].trim() : null;
  };
  const kebab = (key: string): string =>
    key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  it('semanticTokens 每个色值与 tokens.css 同名变量一致', () => {
    for (const [key, value] of Object.entries(semanticTokens)) {
      expect(cssVar(`semantic-${kebab(key)}`)).toBe(value);
    }
  });

  it('riskTokens 四个维度与 tokens.css 同名变量一致', () => {
    // dim= 'color' 对应 CSS 主色变量 --risk-<state>（无 -color 后缀），
    // 其余维度为 --risk-<state>-<dim>。
    const cssName = (state: string, dim: string): string =>
      dim === 'color' ? `risk-${state}` : `risk-${state}-${dim}`;
    for (const [state, dims] of Object.entries(riskTokens)) {
      for (const [dim, value] of Object.entries(dims)) {
        expect(cssVar(cssName(state, dim))).toBe(value);
      }
    }
  });

  it('zScale 与 tokens.css z-index 刻度一致', () => {
    for (const [key, value] of Object.entries(zScale)) {
      expect(cssVar(`z-${kebab(key)}`)).toBe(`${value}`);
    }
  });
});