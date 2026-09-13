/**
 * 软底色（bg-<主色>/10 或 /20）徽标的前景对比度审计（UX-009 axe color-contrast 回归）。
 *
 * 背景（2026-09 缺陷）：`bg-warning/20 text-warning` 这类「软底 + 主色文字」组合在
 * 恒定深色表面（`[data-inverse-surface]`，Command Map 全屏壳 / AlertToast）上不达标——
 * axe 实测 warning/20 = 4.16:1（serious）；info/20 与 primary/20 更差（≈2.7:1）。
 * 该组合会在新鲜度徽标「过期」态切换时出现，且帧饥饿下 computed style 会长时间返回
 * 旧色调，导致 axe 偶发失败（同一测试单跑通过、全量跑失败）。
 *
 * 本测试用**纯计算**（不依赖浏览器）锁定两类回归：
 *  1) 语义审计：所有 `bg-<主色>/N` + 文字组合的对比度必须 ≥ 4.5:1（WCAG 2.2 AA，
 *     9px 粗体不属于大字号例外），覆盖亮色表面与 data-inverse-surface 深色表面；
 *  2) 策略审计：源码中不得再出现「软底 + 主色文字」（必须走 *-foreground / *-on-soft）。
 *
 * 数值口径：token 取自 tokens.css / tailwind-theme.css（单一来源），软底色按
 * 主色 α=0.10/0.15/0.20 合成到所在表面；相对亮度/对比度按 WCAG 2.x 公式。
 * 校验：该模型对历史组合 warning/20 on #1a1d23 复算 4.16，与 axe 报告一致。
 */
import fs from 'node:fs';
import path from 'node:path';

import { FRESHNESS_STATUS_CLASSES } from '../components/DataFreshnessBadge';
import { dataSourceClass } from '../components/DataSourceBadge';

/* ------------------------------------------------------------------ */
/* 颜色模型（WCAG 2.x）                                                */
/* ------------------------------------------------------------------ */
type Rgb = readonly [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const table: ReadonlyArray<Rgb> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(hue / 60) % 6];
  return [r + m, g + m, b + m];
}

export function parseColor(value: string): Rgb {
  const match = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(value.trim());
  if (!match) throw new Error(`无法解析颜色 token：${value}`);
  return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (raw: number): number => {
    const c = Math.min(1, Math.max(0, raw));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度（(L1+0.05)/(L2+0.05)，1..21）。 */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 把带透明度的前景色合成到不透明背景上（软底色 bg-<主色>/20 的实际渲染结果）。 */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ];
}

/* ------------------------------------------------------------------ */
/* token 解析（tokens.css / tailwind-theme.css = 单一来源）             */
/* ------------------------------------------------------------------ */
const TOKENS_CSS = fs.readFileSync(path.resolve(__dirname, '../tokens.css'), 'utf8');
const THEME_CSS = fs.readFileSync(path.resolve(__dirname, '../tailwind-theme.css'), 'utf8');

/** 取某个选择器**全部**声明块内的声明（token 文件里同一选择器会分多块书写）。 */
function blockDeclarations(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 注释里既有分号也有冒号（如「/* normal —— 正常 / 低风险（绿） *\/」），先剥离再解析。
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const needle = `${selector} {`;
  let cursor = 0;
  for (;;) {
    const start = stripped.indexOf(needle, cursor);
    if (start < 0) break;
    const end = stripped.indexOf('\n}', start);
    const body = stripped.slice(start + needle.length, end < 0 ? stripped.length : end);
    cursor = end < 0 ? stripped.length : end + 1;
    for (const decl of body.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      const name = decl.slice(0, idx).trim();
      if (!name.startsWith('--')) continue;
      out[name] = decl.slice(idx + 1).trim();
    }
  }
  return out;
}

/**
 * 解析 token：按「表面作用域 → 全局 :root」的顺序查找（先 tokens.css 再 tailwind-theme.css）。
 * scope 传 '[data-inverse-surface]' 时得到深色表面取值，传 ':root' 时得到默认（亮色）取值。
 */
export function resolveToken(name: string, scope: ':root' | '[data-inverse-surface]'): Rgb {
  const scoped = [
    blockDeclarations(TOKENS_CSS, scope)[name],
    blockDeclarations(THEME_CSS, scope)[name],
  ].find((v): v is string => typeof v === 'string' && v.startsWith('hsl('));
  const fallback = [blockDeclarations(TOKENS_CSS, ':root')[name], blockDeclarations(THEME_CSS, ':root')[name]].find(
    (v): v is string => typeof v === 'string' && v.startsWith('hsl('),
  );
  const value = scoped ?? fallback;
  if (!value) throw new Error(`tokens 中缺少 ${name}`);
  return parseColor(value);
}

/** 表面背景色：深色外壳 --surface-inverse，亮色用 --background。 */
const SURFACE: Record<':root' | '[data-inverse-surface]', string> = {
  ':root': '--background',
  '[data-inverse-surface]': '--surface-inverse',
};

/* ------------------------------------------------------------------ */
/* Tailwind 类名 → (前景色, 软底色)                                     */
/* ------------------------------------------------------------------ */
interface TonePair {
  fg: string;
  bgToken: string;
  alpha: number;
}

/** 从一段 Tailwind 类名里提取「前景 token + 软底色 token/透明度」。 */
export function parseToneClasses(classes: string): TonePair {
  const text = /(?:^|[\s"'`])text-([a-z0-9-]+)/.exec(classes);
  const bg = /(?:^|[\s"'`])bg-([a-z0-9-]+?)(?:\/(\d{1,3}))?(?=[\s"'`]|$)/.exec(classes);
  if (!text || !bg) throw new Error(`类名未同时包含 bg-* 与 text-*：${classes}`);
  const alpha = bg[2] ? Number(bg[2]) / 100 : 1;
  return { fg: `--${text[1]}`, bgToken: `--${bg[1]}`, alpha };
}

function ratioFor(pair: TonePair, scope: ':root' | '[data-inverse-surface]'): number {
  const surface = resolveToken(SURFACE[scope], scope);
  const softBg = composite(resolveToken(pair.bgToken, scope), pair.alpha, surface);
  return contrastRatio(resolveToken(pair.fg, scope), softBg);
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */
const SCOPES = [':root', '[data-inverse-surface]'] as const;
const AA_MIN = 4.5;

describe('软底色徽标对比度（WCAG 2.2 AA ≥ 4.5:1）', () => {
  it('颜色模型复算历史缺陷组合 warning/20 on #1a1d23 = 4.16（与 axe 报告一致）', () => {
    const surface = resolveToken('--surface-inverse', '[data-inverse-surface]');
    const softBg = composite(resolveToken('--warning', '[data-inverse-surface]'), 0.2, surface);
    const ratio = contrastRatio(resolveToken('--warning', '[data-inverse-surface]'), softBg);
    // 该组合曾被 axe 判为 serious（4.16:1）；模型必须复现，否则说明模型口径漂移。
    expect(ratio).toBeGreaterThan(4.0);
    expect(ratio).toBeLessThan(4.5);
  });

  it.each(Object.entries(FRESHNESS_STATUS_CLASSES))(
    '新鲜度色调 %s 在亮色与深色表面上均 ≥ 4.5:1',
    (_status, classes) => {
      const pair = parseToneClasses(classes);
      for (const scope of SCOPES) {
        expect(ratioFor(pair, scope)).toBeGreaterThanOrEqual(AA_MIN);
      }
    },
  );

  it.each(['real', 'controlled_test', 'replayed', 'stale', 'offline', 'simulated'])(
    '数据来源徽标 %s 在亮色与深色表面上均 ≥ 4.5:1',
    (source) => {
      const pair = parseToneClasses(dataSourceClass(source));
      for (const scope of SCOPES) {
        expect(ratioFor(pair, scope)).toBeGreaterThanOrEqual(AA_MIN);
      }
    },
  );

  it('软底文字一律使用 *-foreground / *-on-soft 语义令牌（禁止主色直接作文字色）', () => {
    const pairs = [
      ...Object.values(FRESHNESS_STATUS_CLASSES),
      ...['real', 'controlled_test', 'replayed', 'stale', 'offline', 'simulated'].map((s) => dataSourceClass(s)),
    ];
    for (const classes of pairs) {
      const { fg } = parseToneClasses(classes);
      expect(fg).toMatch(/-foreground$|-on-soft$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 源码策略扫描：不得再出现「软底 + 主色文字」                          */
/* ------------------------------------------------------------------ */
const MAIN_COLORS = ['primary', 'secondary', 'warning', 'info', 'success', 'danger', 'destructive'] as const;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('软底色 + 主色文字 策略扫描（client/src）', () => {
  const clientSrc = path.resolve(__dirname, '..');

  /**
   * 逐「类名串」扫描：同一 className/模板串里同时出现软底主色与主色文字才算违规
   * （不同元素各用一处不构成违规，故不做整文件级别的粗筛）。
   * 带 hover:/focus- 等状态前缀的组合不在静态对比度门的覆盖范围内，跳过。
   */
  it('不存在同一类名串里的「bg-<主色> + text-<主色>」组合', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(clientSrc)) {
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const literal of src.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []) {
        for (const color of MAIN_COLORS) {
          const softBg = new RegExp(`(?:^|[\\s"'\`])bg-${color}(?:/\\d{1,3})?\\b`);
          const mainText = new RegExp(`(?:^|[\\s"'\`])text-${color}(?![\\w-])`);
          if (softBg.test(literal) && mainText.test(literal)) {
            offenders.push(`${path.relative(clientSrc, file)} [${color}] ${literal.trim().slice(0, 80)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
